import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Page, ConsoleMessage, BrowserContext, APIResponse } from "playwright";
import path from "path";
import fs from "fs";
import {
  getOrLaunchBrowser,
  navigateTo,
  getAllPages,
  closeBrowser,
} from "./browser.js";
import { extractContent } from "./extractor.js";
import { assertSafeUrl, resolveSafeOutputDir } from "./security.js";

// ── Helpers ──────────────────────────────────────────────────────────

function textResult(obj: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string) {
  return textResult({ status: "error", message }, true);
}

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
};

function guessExtension(url: string, contentType?: string): string {
  if (contentType && MIME_TO_EXT[contentType]) return MIME_TO_EXT[contentType];
  try {
    const ext = path.extname(new URL(url).pathname).split("?")[0];
    if (ext) return ext;
  } catch {}
  return ".bin";
}

/**
 * Fetches a URL while following redirects MANUALLY, re-validating every hop
 * with assertSafeUrl.
 *
 * Playwright's request context follows redirects on its own (maxRedirects=20 by
 * default) and only the initial URL would otherwise be checked, so a public URL
 * that 3xx-redirects to an internal address (e.g. the cloud metadata endpoint)
 * bypasses the SSRF guard. Disabling auto-follow and re-checking each Location
 * closes that bypass (GHSA-8252-gw22-5q42).
 */
async function getWithSafeRedirects(
  ctx: BrowserContext,
  rawUrl: string,
  maxRedirects = 20
): Promise<APIResponse> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safeUrl = await assertSafeUrl(currentUrl);
    const response = await ctx.request.get(safeUrl.toString(), {
      maxRedirects: 0,
    });
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      if (!location) return response;
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects while fetching ${rawUrl}`);
}

/**
 * Injects a floating capture button into the page.
 * On click, it logs the captureId to the console so Node.js can detect it.
 */
async function injectCaptureButton(
  page: Page,
  captureId: string
): Promise<void> {
  await page
    .evaluate((id: string) => {
      if (document.getElementById("__auth_fetch_btn")) return;

      const btn = document.createElement("button");
      btn.id = "__auth_fetch_btn";
      btn.textContent = "📸 Capture";
      btn.style.cssText = [
        "position:fixed",
        "bottom:24px",
        "right:24px",
        "z-index:2147483647",
        "padding:14px 28px",
        "background:#2563eb",
        "color:#fff",
        "border:none",
        "border-radius:12px",
        "font-size:16px",
        "font-weight:600",
        "cursor:pointer",
        "box-shadow:0 4px 14px rgba(37,99,235,0.4)",
        "transition:all 0.2s",
        "font-family:-apple-system,BlinkMacSystemFont,sans-serif",
      ].join(";");

      btn.onmouseenter = () => {
        btn.style.background = "#1d4ed8";
        btn.style.transform = "scale(1.05)";
      };
      btn.onmouseleave = () => {
        btn.style.background = "#2563eb";
        btn.style.transform = "scale(1)";
      };

      btn.addEventListener("click", () => {
        btn.textContent = "⏳ Capturing...";
        btn.style.background = "#6b7280";
        btn.style.pointerEvents = "none";
        console.log(id);
      });

      document.body.appendChild(btn);
    }, captureId)
    .catch(() => {});
}

// ── Tool Registration ────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  server.registerTool(
    "auth_fetch",
    {
      title: "Auth Fetch",
      description:
        "Fetches web page content using a real browser and returns cleaned HTML. " +
        "MUST be used instead of Fetch/web_fetch when the page requires login or returns empty/minimal HTML " +
        "(e.g. Notion, Google Docs, Jira, Confluence, Linear, Slack, or any SaaS/private page). " +
        "Do NOT suggest copy-paste or PDF export — use this tool first. " +
        "Opens a browser window, the user logs in if needed, clicks the capture button, " +
        "and the content is returned as cleaned HTML (noise stripped, media preserved). " +
        "To download images or files from the result, use download_media with the URLs.",
      inputSchema: {
        url: z.string().describe("The URL to fetch content from"),
        wait_for: z
          .string()
          .optional()
          .describe(
            "Optional CSS selector to wait for before capturing (useful for SPAs)"
          ),
      },
    },
    async ({ url, wait_for }) => {
      try {
        const ctx = await getOrLaunchBrowser(true);
        const page = await navigateTo(ctx, url);
        const captureId = `__AUTH_FETCH_${Date.now()}__`;

        const capturePromise = new Promise<void>((resolve) => {
          const handler = (msg: ConsoleMessage) => {
            if (msg.text() === captureId) {
              page.removeListener("console", handler);
              resolve();
            }
          };
          page.on("console", handler);
        });

        const closePromise = new Promise<never>((_, reject) => {
          ctx.on("close", () =>
            reject(new Error("Browser closed before capture"))
          );
        });

        await injectCaptureButton(page, captureId);
        page.on("load", () => injectCaptureButton(page, captureId));

        await Promise.race([capturePromise, closePromise]);

        await page.waitForTimeout(500);
        if (wait_for) {
          await page
            .waitForSelector(wait_for, { timeout: 10000 })
            .catch(() => {});
        }

        await page
          .evaluate(() =>
            document.getElementById("__auth_fetch_btn")?.remove()
          )
          .catch(() => {});

        const result = await extractContent(page);
        await closeBrowser();

        return textResult({
          status: "ok",
          url: result.url,
          title: result.title,
          content: result.content,
        });
      } catch (err) {
        try { await closeBrowser(); } catch {}
        const msg = (err as Error).message;
        return errorResult(
          msg.includes("Browser closed before capture")
            ? "Browser was closed before capture."
            : `Failed to fetch page: ${msg}`
        );
      }
    }
  );

  server.registerTool(
    "download_media",
    {
      title: "Download Media",
      description:
        "Downloads files from URLs using saved browser sessions. " +
        "Use this to download images, videos, or other files found in auth_fetch results. " +
        "The browser's saved cookies handle authentication automatically — no need to log in again.",
      inputSchema: {
        urls: z
          .array(z.string())
          .describe("One or more URLs to download"),
        output_dir: z
          .string()
          .optional()
          .describe(
            "Optional directory to save files to. " +
            "Defaults to ~/.auth-fetch-mcp/downloads/<timestamp>/"
          ),
      },
    },
    async ({ urls, output_dir }) => {
      const MAX_FILE_SIZE = 50 * 1024 * 1024;

      try {
        const ctx = await getOrLaunchBrowser(false);
        let dir: string;
        try {
          dir = resolveSafeOutputDir(output_dir);
        } catch (err) {
          await closeBrowser();
          return errorResult((err as Error).message);
        }

        const files: {
          url: string;
          localPath?: string;
          size?: number;
          error?: string;
        }[] = [];

        let counter = 0;
        for (const url of urls) {
          try {
            const response = await getWithSafeRedirects(ctx, url);
            if (!response.ok()) {
              files.push({ url, error: `HTTP ${response.status()}` });
              continue;
            }

            const body = await response.body();
            if (body.length > MAX_FILE_SIZE) {
              files.push({
                url,
                error: `Too large (${(body.length / 1024 / 1024).toFixed(1)}MB)`,
              });
              continue;
            }

            const contentType = response.headers()["content-type"]?.split(";")[0];
            const ext = guessExtension(url, contentType);
            const filePath = path.join(dir, `file-${++counter}${ext}`);

            fs.writeFileSync(filePath, body);
            files.push({ url, localPath: filePath, size: body.length });
          } catch (err) {
            files.push({ url, error: (err as Error).message });
          }
        }

        await closeBrowser();

        return textResult({
          status: "ok",
          directory: dir,
          downloaded: files.filter((f) => f.localPath).length,
          total: urls.length,
          files,
        });
      } catch (err) {
        try { await closeBrowser(); } catch {}
        return errorResult(`Download failed: ${(err as Error).message}`);
      }
    }
  );

  server.registerTool(
    "list_pages",
    {
      title: "List Pages",
      description:
        "Lists all open tabs in the browser with their URLs and titles.",
    },
    async () => {
      const pages = await getAllPages();
      return textResult({ pages, count: pages.length });
    }
  );

  server.registerTool(
    "close_browser",
    {
      title: "Close Browser",
      description:
        "Closes the browser window. Login sessions are saved and will be reused next time.",
    },
    async () => {
      await closeBrowser();
      return textResult({
        message: "Browser closed. Sessions are saved for next time.",
      });
    }
  );
}
