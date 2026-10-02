import { chromium, BrowserContext, Page } from "playwright";
import { execSync } from "child_process";
import path from "path";
import { assertSafeUrl } from "./security.js";
import { startSafeProxy } from "./proxy.js";

let context: BrowserContext | null = null;

const USER_DATA_DIR = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".auth-fetch-mcp", "browser-data");
})();

/**
 * Launches (or returns) a persistent browser context.
 * Session cookies are stored on disk and reused across restarts.
 */
export async function getOrLaunchBrowser(
  headed: boolean = true
): Promise<BrowserContext> {
  if (context) return context;

  const proxy = await startSafeProxy();
  const launchOptions = {
    proxy: { server: proxy.url },
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--proxy-bypass-list=<-loopback>",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  };

  try {
    context = await chromium.launchPersistentContext(
      USER_DATA_DIR,
      launchOptions
    );
  } catch {
    try {
      execSync("npx playwright install chromium", { stdio: "inherit" });
      context = await chromium.launchPersistentContext(
        USER_DATA_DIR,
        launchOptions
      );
    } catch (err) {
      proxy.close();
      throw err;
    }
  }

  context.on("close", () => {
    proxy.close();
    context = null;
  });

  return context;
}

/**
 * Navigates to the given URL, reusing a blank tab if available.
 */
export async function navigateTo(
  ctx: BrowserContext,
  url: string
): Promise<Page> {
  const safeUrl = await assertSafeUrl(url);

  const pages = ctx.pages();
  const page =
    pages.length > 0 && pages[pages.length - 1].url() === "about:blank"
      ? pages[pages.length - 1]
      : await ctx.newPage();

  await page.goto(safeUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  return page;
}

/**
 * Lists all open tabs with their URLs and titles.
 */
export async function getAllPages(): Promise<
  { url: string; title: string }[]
> {
  if (!context) return [];
  return Promise.all(
    context.pages().map(async (page) => ({
      url: page.url(),
      title: await page.title(),
    }))
  );
}

/**
 * Closes the browser. Session data stays on disk for next time.
 */
export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}
