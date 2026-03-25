import { chromium, BrowserContext, Page } from "playwright";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

let context: BrowserContext | null = null;

/**
 * Returns the persistent browser data directory (~/.auth-fetch-mcp/browser-data/).
 * Creates it if it doesn't exist.
 */
export function getUserDataDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const dir = path.join(home, ".auth-fetch-mcp", "browser-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether a saved session (persistent context data) exists on disk.
 * We check for the presence of key Chromium profile files.
 */
export function hasSavedSession(): boolean {
  const dir = getUserDataDir();
  // Chromium writes "Cookies" and "Default/Cookies" depending on version
  return (
    fs.existsSync(path.join(dir, "Default")) ||
    fs.existsSync(path.join(dir, "Cookies"))
  );
}

/**
 * Returns the live browser context if one is open, or null.
 */
export function getContext(): BrowserContext | null {
  return context;
}

/**
 * Launches (or returns) a persistent browser context.
 * @param headed - true to show the browser window (for user login), false for background fetch
 */
export async function getOrLaunchBrowser(
  headed: boolean = true
): Promise<BrowserContext> {
  if (context) return context;

  const userDataDir = getUserDataDir();

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: !headed,
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  } catch (e) {
    // Chromium not installed — auto-install and retry
    execSync("npx playwright install chromium", { stdio: "inherit" });
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: !headed,
      viewport: { width: 1280, height: 800 },
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  context.on("close", () => {
    context = null;
  });

  return context;
}

/**
 * Navigates a page to the given URL.
 * Reuses an existing blank tab or creates a new one.
 */
export async function navigateTo(
  ctx: BrowserContext,
  url: string
): Promise<Page> {
  const pages = ctx.pages();
  // Reuse the last page if it's a blank tab
  let page =
    pages.length > 0 && pages[pages.length - 1].url() === "about:blank"
      ? pages[pages.length - 1]
      : await ctx.newPage();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return page;
}

/**
 * Returns the most recently active page, or null.
 */
export async function getActivePage(): Promise<Page | null> {
  if (!context) return null;
  const pages = context.pages();
  return pages.length > 0 ? pages[pages.length - 1] : null;
}

/**
 * Lists all open tabs with their URLs and titles.
 */
export async function getAllPages(): Promise<
  { url: string; title: string }[]
> {
  if (!context) return [];
  const pages = context.pages();
  const result: { url: string; title: string }[] = [];
  for (const page of pages) {
    result.push({
      url: page.url(),
      title: await page.title(),
    });
  }
  return result;
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
