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
 * Installs a request guard that re-validates page requests against
 * assertSafeUrl, aborting any that resolves to a private/loopback/link-local
 * address.
 *
 * A one-time check on the initial URL cannot catch a public URL that issues a
 * 3xx redirect to an internal address (or a DNS-rebinding host). The tricky
 * part is that Chromium follows a top-level/frame *document* redirect INTERNALLY
 * and does NOT re-invoke page.route for the redirect target (verified: only the
 * initial navigation and subresources are surfaced). So for documents we follow
 * redirects ourselves via route.fetch({maxRedirects:0}) and re-validate each
 * hop; subresources are surfaced individually, so validate-and-continue suffices
 * for them. Closes GHSA-8252-gw22-5q42.
 */
async function installSsrfGuard(page: Page): Promise<void> {
  // Cache decisions per host for the lifetime of this guard so a page with
  // many subresources does not trigger a DNS lookup on every request.
  const decisions = new Map<string, boolean>();

  const isSafe = async (rawUrl: string): Promise<boolean> => {
    let host: string;
    try {
      host = new URL(rawUrl).host;
    } catch {
      return false;
    }
    const cached = decisions.get(host);
    if (cached !== undefined) return cached;
    // assertSafeUrl rejects private/loopback/link-local hosts AND non-http(s)
    // schemes (e.g. a document redirected to file:), so both are treated unsafe.
    const ok = await assertSafeUrl(rawUrl).then(
      () => true,
      () => false
    );
    decisions.set(host, ok);
    return ok;
  };

  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = request.url();

    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      return route.continue();
    }
    // Non-network schemes (data:, blob:, about:, filesystem:) carry no
    // resolvable host and cannot reach an internal service — let them through.
    if (protocol !== "http:" && protocol !== "https:") {
      return route.continue();
    }

    // Subresources (images, scripts, XHR/fetch) are each surfaced to this
    // handler on their own, so a single validate-and-continue is enough.
    if (request.resourceType() !== "document") {
      return (await isSafe(url))
        ? route.continue()
        : route.abort("blockedbyclient");
    }

    // Document navigation: follow redirects manually, re-validating each hop,
    // and fulfill the browser with the final (validated) response.
    let current = url;
    for (let hop = 0; hop <= 20; hop++) {
      if (!(await isSafe(current))) return route.abort("blockedbyclient");

      let response;
      try {
        response = await route.fetch({ url: current, maxRedirects: 0 });
      } catch {
        return route.abort("failed");
      }

      const status = response.status();
      if (status >= 300 && status < 400) {
        const location = response.headers()["location"];
        if (!location) return route.fulfill({ response });
        current = new URL(location, current).toString();
        continue;
      }
      return route.fulfill({ response });
    }
    return route.abort("blockedbyclient");
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
