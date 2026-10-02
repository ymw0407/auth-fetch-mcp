import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Page, ConsoleMessage, BrowserContext, APIResponse } from "playwright";
import { randomUUID } from "node:crypto";
import { ImageContent } from "@modelcontextprotocol/sdk/types.js";
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

function textResult(obj: Record<string, unknown>, isError = false, images: ImageContent[] = []) {
  return {
    structuredContent: obj,
    content: [{ type: "text" as const, text: JSON.stringify(obj) }, ...images],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message }) }], isError: true };
}

let browserBusy = false;

const linkSchema = z.object({ url: z.string(), label: z.string() });
const mediaSchema = linkSchema.extend({ type: z.string(), downloadable: z.boolean() });
const fileSchema = z.object({ url: z.string(), localPath: z.string().optional(), size: z.number().optional(), error: z.string().optional(), preview_included: z.boolean().optional() });

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
    if (/^\.[a-z0-9]{1,12}$/i.test(ext)) return ext;
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
      timeout: 30000,
    });
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      if (!location) return response;
      await response.dispose();
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }
    return response;
  }
  throw new Error(`Too many redirects while fetching ${rawUrl}`);
}

/** Isolated styles keep the capture controls readable on arbitrary sites. */
export async function injectCaptureButton(page: Page, captureId: string): Promise<void> {
  await page.evaluate((id: string) => {
    if (document.getElementById("__auth_fetch_panel")) return;
    const host = document.createElement("div");
    host.id = "__auth_fetch_panel";
    host.style.cssText = "all:initial;position:fixed;bottom:24px;right:24px;z-index:2147483647;width:min(340px,calc(100vw - 32px))";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}section{padding:22px;border:1px solid #334155;border-radius:18px;background:#0f172a;color:#f8fafc;box-shadow:0 16px 48px #0006;font:14px/1.5 system-ui,sans-serif}
        .brand{font-size:11px;font-weight:700;letter-spacing:.14em;color:#5eead4}h2{font-size:20px;line-height:1.3;margin:10px 0}p{color:#cbd5e1;margin:0 0 18px}.actions{display:flex;gap:10px}
        button{font:600 14px system-ui;min-height:44px;border-radius:10px;cursor:pointer}button:focus-visible{outline:3px solid #f8fafc;outline-offset:3px}
        .capture{flex:1;background:#5eead4;color:#0f172a;border:0;padding:12px 16px}.capture:hover{background:#99f6e4}.capture:disabled{opacity:.6;cursor:wait}.cancel{border:1px solid #475569;background:transparent;color:#e2e8f0;padding:12px}
        .status{margin:14px 0 0;font-size:12px;color:#94a3b8}
      </style>
      <section aria-label="Auth Fetch capture controls">
        <div class="brand">AUTH FETCH</div><h2>Ready when you are</h2>
        <p>Sign in and open the content you want your AI to read. Scroll or expand it before capturing.</p>
        <div class="actions"><button class="capture" type="button">Capture page</button><button class="cancel" type="button">Cancel</button></div>
        <p class="status" role="status" aria-live="polite">Waiting for your confirmation.</p>
      </section>`;
    const button = shadow.querySelector<HTMLButtonElement>(".capture")!;
    button.addEventListener("click", event => {
      if (!event.isTrusted) return;
      button.disabled = true;
      button.textContent = "Capturing…";
      shadow.querySelector(".status")!.textContent = "Reading this page. Content will be sent to your AI.";
      console.log(id);
    });
    shadow.querySelector(".cancel")!.addEventListener("click", event => {
      if (event.isTrusted) console.log(`${id}:cancel`);
    });
    document.body.appendChild(host);
  }, captureId);
}

/** Bounded human wait, with cancellation and listener/timer cleanup. */
export function waitForCapture(page: Page, ctx: BrowserContext, captureId: string, timeoutMs: number, signal: AbortSignal) {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { cleanup(); error ? reject(error) : resolve(); };
    const onConsole = (message: ConsoleMessage) => {
      if (message.text() === captureId) finish();
      if (message.text() === `${captureId}:cancel`) finish(new Error("Capture cancelled by the user."));
    };
    const onClose = () => finish(new Error("Browser or page closed before capture."));
    const onAbort = () => finish(new Error("Capture cancelled by the client."));
    const timer = setTimeout(() => finish(new Error("Capture timed out. Sign in and click Capture page before the timeout, then retry.")), timeoutMs);
    cleanup = () => {
      clearTimeout(timer);
      page.removeListener("console", onConsole);
      page.removeListener("close", onClose);
      ctx.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    page.on("console", onConsole);
    page.once("close", onClose);
    ctx.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return { promise, dispose: cleanup };
}

// ── Tool Registration ────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  server.registerTool(
    "auth_fetch",
    {
      title: "Auth Fetch",
      description:
        "Read a login-protected page using a local browser and human-approved capture. " +
        "Use for authenticated pages or when normal web reading returns a login screen or empty content. " +
        "Tell the user to sign in and click Capture page before calling. Returns a loaded-DOM snapshot, source URL, time, links, media and completeness warnings. " +
        "Prefer format=text for reading; html preserves markup. Canvas, frame contents and unloaded content are not extracted. This call waits for the user.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      outputSchema: {
        status: z.literal("ok"), url: z.string(), title: z.string(), content: z.string(),
        format: z.enum(["html", "text"]), captured_at: z.string(), truncated: z.boolean(), original_length: z.number(),
        links: z.array(linkSchema), media: z.array(mediaSchema), links_truncated: z.boolean(), media_truncated: z.boolean(), warnings: z.array(z.string()),
      },
      inputSchema: {
        url: z.string().describe("The URL to fetch content from"),
        wait_for: z.string().optional().describe("CSS selector that must be visible after the user captures. A missing selector returns an error."),
        format: z.enum(["html", "text"]).default("text").describe("Defaults to readable text. Select html when markup is needed."),
        max_chars: z.number().int().min(1000).max(100000).default(20000).describe("Maximum returned content characters. Defaults to 20000; check truncated."),
        timeout_seconds: z.number().int().min(30).max(1800).default(600).describe("Time allowed for manual login and Capture page. Configure the client's tool timeout to be longer."),
      },
    },
    async ({ url, wait_for, format, max_chars, timeout_seconds }, extra) => {
      if (browserBusy) return errorResult("Another capture or download is running. Wait for it to finish; run browser tools sequentially.");
      browserBusy = true;
      let pending: ReturnType<typeof waitForCapture> | undefined;
      let progressTimer: NodeJS.Timeout | undefined;
      let page: Page | undefined;
      let onLoad: (() => void) | undefined;
      try {
        await assertSafeUrl(url);
        const ctx = await getOrLaunchBrowser(true);
        page = await navigateTo(ctx, url);
        const captureId = `__AUTH_FETCH_${randomUUID()}__`;
        pending = waitForCapture(page, ctx, captureId, timeout_seconds * 1000, extra.signal);
        // Attach the race immediately, so cancellation during injection is handled.
        const injection = injectCaptureButton(page, captureId);
        await Promise.race([injection, pending.promise]);
        onLoad = () => { void injectCaptureButton(page!, captureId).catch(() => {}); };
        page.on("load", onLoad);
        const started = Date.now();
        const token = extra._meta?.progressToken;
        if (token !== undefined) {
          const progress = () => extra.sendNotification({ method: "notifications/progress", params: {
            progressToken: token, progress: Math.floor((Date.now() - started) / 1000), total: timeout_seconds,
            message: "Waiting for you to sign in and click Capture page in the browser.",
          } }).catch(() => {});
          await progress();
          progressTimer = setInterval(() => { void progress(); }, 15000);
        }
        await pending.promise;
        if (wait_for) await page.waitForSelector(wait_for, { state: "visible", timeout: 10000 });
        await page.evaluate(() => document.getElementById("__auth_fetch_panel")?.remove());
        const result = await extractContent(page, format, max_chars);
        return textResult({ status: "ok", ...result });
      } catch (err) {
        return errorResult(`Failed to capture page: ${(err as Error).message}`);
      } finally {
        pending?.dispose();
        if (progressTimer) clearInterval(progressTimer);
        if (page && onLoad) page.removeListener("load", onLoad);
        try { await closeBrowser(); } catch {}
        browserBusy = false;
      }
    }
  );

  server.registerTool(
    "download_media",
    {
      title: "Download Media",
      description:
        "Download only attachments needed for the user's task using saved browser cookies. " +
        "Returns local paths, sizes, and per-file errors. Check downloaded before reporting success. " +
        "Cookies may not cover sites that require JavaScript-generated authorization headers. " +
        "Use include_preview to return small PNG/JPEG/WebP images directly to the AI; larger files need a local file viewer. Run after auth_fetch finishes.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      outputSchema: { status: z.enum(["ok", "partial", "error"]), directory: z.string(), downloaded: z.number(), total: z.number(), files: z.array(fileSchema) },
      inputSchema: {
        include_preview: z.boolean().default(false).describe("Include small PNG/JPEG/WebP images as MCP image content, within a shared 1 MiB preview budget. Local paths are always returned."),
        urls: z
          .array(z.string()).min(1).max(50)
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
    async ({ urls, output_dir, include_preview }) => {
      if (browserBusy) return errorResult("Another capture or download is running. Run browser tools sequentially.");
      browserBusy = true;
      const images: ImageContent[] = [];
      // ponytail: 1 MiB total inline previews; use local file tools for larger images.
      let previewBudget = 1024 * 1024;
      const MAX_FILE_SIZE = 50 * 1024 * 1024;

      try {
        const ctx = await getOrLaunchBrowser(false);
        const dir = resolveSafeOutputDir(output_dir);

        const files: {
          url: string;
          localPath?: string;
          size?: number;
          error?: string;
          preview_included?: boolean;
        }[] = [];

        let counter = 0;
        for (const url of urls) {
          try {
            const response = await getWithSafeRedirects(ctx, url);
            try {
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

              fs.writeFileSync(filePath, body, { flag: "wx" });
              const preview = include_preview && ["image/png", "image/jpeg", "image/webp"].includes(contentType) && body.length <= previewBudget;
              if (preview) {
                images.push({ type: "image", data: body.toString("base64"), mimeType: contentType });
                previewBudget -= body.length;
              }
              files.push({ url, localPath: filePath, size: body.length, preview_included: preview });
            } finally { await response.dispose(); }
          } catch (err) {
            files.push({ url, error: (err as Error).message });
          }
        }

        const downloaded = files.filter(file => file.localPath).length;
        return textResult({
          status: downloaded === urls.length ? "ok" : downloaded > 0 ? "partial" : "error",
          directory: dir, downloaded, total: urls.length, files,
        }, downloaded === 0, images);
      } catch (err) {
        return errorResult(`Download failed: ${(err as Error).message}`);
      } finally {
        try { await closeBrowser(); } catch {}
        browserBusy = false;
      }
    }
  );

  server.registerTool(
    "list_pages",
    {
      title: "List Pages",
      description:
        "Inspect open browser tabs without navigating. Returns URLs and titles; it does not capture page content.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      outputSchema: { pages: z.array(z.object({ url: z.string(), title: z.string() })), count: z.number() },
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
        "Close the browser when the user asks to cancel. An active capture will fail; saved login sessions are retained. Do not call during capture unless cancellation is intended.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      outputSchema: { message: z.string() },
    },
    async () => {
      await closeBrowser();
      return textResult({ message: "Browser closed. Login sessions are retained." });
    }
  );
}
