import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getContext,
  getOrLaunchBrowser,
  hasSavedSession,
  navigateTo,
  getActivePage,
  getAllPages,
  closeBrowser,
} from "./browser.js";
import { waitForContent, extractContent } from "./extractor.js";

function textResult(obj: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerTools(server: McpServer): void {
  // ── auth_fetch ────────────────────────────────────────────────────
  server.registerTool(
    "auth_fetch",
    {
      title: "Auth Fetch",
      description:
        "Fetches content from a URL that may require authentication. " +
        "If no browser session exists, it opens a browser window for the user to log in manually. " +
        "Call this again after the user confirms login is complete. " +
        "If a session already exists, it fetches the content immediately without opening a browser.",
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
        // ─── Case 1: Browser is already open ───────────────────────
        const existingCtx = getContext();
        if (existingCtx) {
          const page = await navigateTo(existingCtx, url);
          await waitForContent(page, wait_for);
          const result = await extractContent(page);

          if (result.content.length < 50) {
            return textResult({
              status: "ok",
              url: result.url,
              title: result.title,
              content: result.content,
              warning:
                "Content is very short. The page may still be loading or may require login. " +
                "Try using the wait_for option or call auth_fetch again after logging in.",
            });
          }

          return textResult({
            status: "ok",
            url: result.url,
            title: result.title,
            content: result.content,
          });
        }

        // ─── Case 2: No browser open, but saved session exists ─────
        if (hasSavedSession()) {
          // Launch headless — we have saved cookies
          const ctx = await getOrLaunchBrowser(/* headed */ false);
          const page = await navigateTo(ctx, url);
          await waitForContent(page, wait_for);

          // Check if we got redirected to a login page (heuristic)
          const finalUrl = page.url();
          const isLoginPage = await page.evaluate(() => {
            const text = document.body.innerText?.toLowerCase() || "";
            const url = window.location.href.toLowerCase();
            return (
              url.includes("/login") ||
              url.includes("/signin") ||
              url.includes("/auth") ||
              (text.includes("sign in") && text.length < 500) ||
              (text.includes("log in") && text.length < 500)
            );
          });

          if (isLoginPage) {
            // Session expired — close headless, reopen headed for login
            await closeBrowser();
            const headedCtx = await getOrLaunchBrowser(/* headed */ true);
            await navigateTo(headedCtx, url);
            return textResult({
              status: "awaiting_login",
              message: `Session expired. Browser opened at ${url}. Please log in and let me know when you're done.`,
            });
          }

          const result = await extractContent(page);
          // Close headless browser after capture
          await closeBrowser();

          return textResult({
            status: "ok",
            url: result.url,
            title: result.title,
            content: result.content,
          });
        }

        // ─── Case 3: No browser, no saved session → headed for login
        const ctx = await getOrLaunchBrowser(/* headed */ true);
        await navigateTo(ctx, url);
        return textResult({
          status: "awaiting_login",
          message: `Browser opened at ${url}. Please log in and let me know when you're done.`,
        });
      } catch (err) {
        // If browser crashed, clean up state
        try {
          await closeBrowser();
        } catch {
          // ignore cleanup errors
        }
        return textResult(
          {
            status: "error",
            message: `Failed to fetch page: ${(err as Error).message}`,
          },
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
