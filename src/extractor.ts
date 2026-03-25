import { Page } from "playwright";
import TurndownService from "turndown";

const MAX_CONTENT_LENGTH = 50_000;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Preserve images as markdown ![alt](src)
turndown.addRule("keepImages", {
  filter: "img",
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const src = el.getAttribute("src") || "";
    const alt = el.getAttribute("alt") || "";
    if (!src) return "";
    return `![${alt}](${src})`;
  },
});

/**
 * Waits for the page content to be ready.
 * If a CSS selector is provided, waits for that element.
 * Otherwise uses a heuristic: DOM loaded + body text > 100 chars.
 */
export async function waitForContent(
  page: Page,
  waitFor?: string
): Promise<void> {
  if (waitFor) {
    await page.waitForSelector(waitFor, { timeout: 15000 });
    return;
  }

  await page.waitForLoadState("domcontentloaded");

  // Wait for body to have meaningful text (catches SPA rendering)
  await page
    .waitForFunction(
      () => (document.body.innerText?.length || 0) > 100,
      { timeout: 10000 }
    )
    .catch(() => {
      // Timeout OK — proceed with current state
    });

  // Short extra wait for late-loading elements
  await page.waitForTimeout(1000);
}

/**
 * Extracts page content as Markdown.
 * Prefers semantic containers (article, main) and strips noise elements.
 */
export async function extractContent(page: Page): Promise<{
  url: string;
  title: string;
  content: string;
}> {
  const url = page.url();
  const title = await page.title();

  const html = await page.evaluate(() => {
    const el =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector(".notion-page-content") ||
      document.body;

    // Strip noise elements
    const clone = el.cloneNode(true) as HTMLElement;
    const noiseSelectors = [
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
    noiseSelectors.forEach((sel) =>
      clone.querySelectorAll(sel).forEach((n) => n.remove())
    );
    return clone.innerHTML;
  });

  let content = turndown.turndown(html);

  // Clean up excessive whitespace
  content = content.replace(/\n{3,}/g, "\n\n").trim();

  // Truncate if too long
  if (content.length > MAX_CONTENT_LENGTH) {
    content =
      content.slice(0, MAX_CONTENT_LENGTH) +
      "\n\n---\n*[Content truncated — original was " +
      content.length +
      " characters]*";
  }

  return { url, title, content };
}
