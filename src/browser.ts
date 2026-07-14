import { chromium, BrowserContext, Page } from "playwright";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { assertSafeUrl } from "./security.js";

let context: BrowserContext | null = null;

const USER_DATA_DIR = (() => {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const dir = path.join(home, ".auth-fetch-mcp", "browser-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

/**
 * Launches (or returns) a persistent browser context.
 * Session cookies are stored on disk and reused across restarts.
 */
export async function getOrLaunchBrowser(
  headed: boolean = true
): Promise<BrowserContext> {
  if (context) return context;

  const launchOptions = {
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  try {
    context = await chromium.launchPersistentContext(
      USER_DATA_DIR,
      launchOptions
    );
  } catch {
    execSync("npx playwright install chromium", { stdio: "inherit" });
    context = await chromium.launchPersistentContext(
      USER_DATA_DIR,
      launchOptions
    );
  }

  context.on("close", () => {
    context = null;
  });

  return context;
}

/**
 * Installs a request guard that re-validates EVERY http(s) request the page
 * makes — the top-level navigation, redirect targets, and every subresource —
 * against assertSafeUrl, aborting any that resolves to a private/loopback/
 * link-local address.
 *
 * A one-time check on the initial URL cannot catch a public URL that issues a
 * 3xx redirect to an internal address (or a DNS-rebinding host), because
 * page.goto follows redirects and the browser re-resolves DNS itself. Guarding
 * at the request layer closes that bypass (GHSA-8252-gw22-5q42).
 */
async function installSsrfGuard(page: Page): Promise<void> {
  // Cache decisions per host for the lifetime of this guard so a page with
  // many subresources does not trigger a DNS lookup on every request.
  const decisions = new Map<string, boolean>();

  await page.route("**/*", async (route) => {
    const reqUrl = route.request().url();
    let parsed: URL;
    try {
      parsed = new URL(reqUrl);
    } catch {
      return route.continue();
    }
    // Only http/https reach the network with a resolvable host; let data:,
    // blob:, about:, etc. through untouched.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return route.continue();
    }

    let safe = decisions.get(parsed.host);
    if (safe === undefined) {
      safe = await assertSafeUrl(reqUrl).then(
        () => true,
        () => false
      );
      decisions.set(parsed.host, safe);
    }
    return safe ? route.continue() : route.abort("blockedbyclient");
  });
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

  await installSsrfGuard(page);

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
