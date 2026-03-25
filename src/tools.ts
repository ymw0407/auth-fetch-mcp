import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConsoleMessage } from "playwright";
import {
  getOrLaunchBrowser,
  navigateTo,
  getAllPages,
  closeBrowser,
} from "./browser.js";
import { extractContent } from "./extractor.js";

function textResult(obj: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Injects a floating capture button into the page.
 * On click, it logs a unique captureId to the console so Node.js can detect it.
 */
async function injectCaptureButton(
  page: { evaluate: Function },
  captureId: string
): Promise<void> {
  await (page as any)
    .evaluate((id: string) => {
      if (document.getElementById("__auth_fetch_btn")) return;

      const btn = document.createElement("button");
      btn.id = "__auth_fetch_btn";
      btn.textContent = "📸 캡처하기";
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
        btn.textContent = "⏳ 캡처 중...";
        btn.style.background = "#6b7280";
        btn.style.pointerEvents = "none";
        console.log(id);
      });

      document.body.appendChild(btn);
    }, captureId)
    .catch(() => {});
}

export function registerTools(server: McpServer): void {
  // ── auth_fetch ────────────────────────────────────────────────────
  server.registerTool(
    "auth_fetch",
    {
      title: "Auth Fetch",
      description:
        "Fetches content from a URL that may require authentication. " +
        "Use this tool when web_fetch or Fetch returns a login page, empty content, or access denied for URLs like Notion, Google Docs, Jira, Confluence, etc. " +
        "Opens a real browser window so the user can log in manually (SSO, 2FA, CAPTCHA all supported). " +
        "A capture button appears on the page — the user clicks it when ready, then the content is returned as Markdown and the browser closes.",
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

        // Unique ID for this capture session
        const captureId = `__AUTH_FETCH_${Date.now()}__`;

        // Listen for the capture button click via console message
        const capturePromise = new Promise<void>((resolve) => {
          const handler = (msg: ConsoleMessage) => {
            if (msg.text() === captureId) {
              page.removeListener("console", handler);
              resolve();
            }
          };
          page.on("console", handler);
        });

        // Detect if user closes the browser before clicking capture
        const closePromise = new Promise<never>((_, reject) => {
          ctx.on("close", () =>
            reject(new Error("Browser closed before capture"))
          );
        });

        // Inject button now and re-inject after every navigation (login redirects, etc.)
        await injectCaptureButton(page, captureId);
        page.on("load", () => injectCaptureButton(page, captureId));

        // Wait for button click or browser close
        await Promise.race([capturePromise, closePromise]);

        // Short wait for any late-rendering content
        await page.waitForTimeout(500);
        if (wait_for) {
          await page
            .waitForSelector(wait_for, { timeout: 10000 })
            .catch(() => {});
        }

        // Remove the button before capturing
        await page
          .evaluate(() => {
            document.getElementById("__auth_fetch_btn")?.remove();
          })
          .catch(() => {});

        // Capture content
        const result = await extractContent(page);

        // Close browser
        await closeBrowser();

        return textResult({
          status: "ok",
          url: result.url,
          title: result.title,
          content: result.content,
        });
      } catch (err) {
        try {
          await closeBrowser();
        } catch {
          // ignore cleanup errors
        }
        const msg = (err as Error).message;
        if (msg.includes("Browser closed before capture")) {
          return textResult(
            {
              status: "error",
              message: "Browser was closed before capture.",
            },
            true
          );
        }
        return textResult(
          { status: "error", message: `Failed to fetch page: ${msg}` },
          true
        );
      }
    }
  );

  // ── list_pages ────────────────────────────────────────────────────
  server.registerTool(
    "list_pages",
    {
      title: "List Pages",
      description:
        "Lists all open tabs in the browser with their URLs and titles.",
    },
    async () => {
      const pages = await getAllPages();
      return textResult({
        pages,
        count: pages.length,
      });
    }
  );

  // ── close_browser ─────────────────────────────────────────────────
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
