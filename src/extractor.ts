import { Page } from "playwright";

const MAX_CONTENT_LENGTH = 100_000;

const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".sidebar",
  ".menu",
  ".toolbar",
  ".cookie-banner",
];

/**
 * Extracts page content as cleaned HTML.
 * Prefers semantic containers (article, main) and strips noise elements.
 */
export async function extractContent(page: Page): Promise<{
  url: string;
  title: string;
  content: string;
}> {
  const url = page.url();
  const title = await page.title();

  let content = await page.evaluate((selectors: string[]) => {
    const el =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector(".notion-page-content") ||
      document.body;

    const clone = el.cloneNode(true) as HTMLElement;
    selectors.forEach((sel) =>
      clone.querySelectorAll(sel).forEach((n) => n.remove())
    );
    return clone.innerHTML;
  }, NOISE_SELECTORS);

  if (content.length > MAX_CONTENT_LENGTH) {
    content =
      content.slice(0, MAX_CONTENT_LENGTH) +
      `\n<!-- Content truncated — original was ${content.length} characters -->`;
  }

  return { url, title, content };
}
