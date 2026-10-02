import { Page } from "playwright";

const NOISE_SELECTORS = [
  "script", "style", "noscript", "nav", "header", "footer",
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  ".sidebar", ".menu", ".toolbar", ".cookie-banner",
  "[hidden]", '[aria-hidden="true"]', "#__auth_fetch_panel",
];

/** A snapshot of the currently loaded DOM, not a guarantee of a complete document. */
export async function extractContent(
  page: Page,
  format: "html" | "text" = "text",
  maxChars = 20_000
) {
  const url = page.url();
  const title = await page.title();
  const snapshot = await page.evaluate(({ selectors, format }) => {
    const source = document.querySelector("article") || document.querySelector("main") ||
      document.querySelector('[role="main"]') || document.querySelector(".notion-page-content") || document.body;
    const clone = source.cloneNode(true) as HTMLElement;
    selectors.forEach(selector => clone.querySelectorAll(selector).forEach(node => node.remove()));

    const links = Array.from(clone.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map(node => ({ url: node.href, label: (node.textContent || "").trim() }))
      .filter(link => /^https?:/.test(link.url));
    const media = Array.from(clone.querySelectorAll<HTMLImageElement | HTMLMediaElement | HTMLIFrameElement>("img[src], video[src], audio[src], source[src], iframe[src]"))
      .map(node => ({ url: node.src, type: node.tagName.toLowerCase(), label: node.getAttribute("alt") || node.getAttribute("title") || "", downloadable: /^https?:/.test(node.src) }));
    const warnings = ["This snapshot contains currently loaded DOM content only. Scroll or expand the page before capturing if needed."];
    if (source.querySelector("canvas")) warnings.push("Canvas content is not extracted. The document may be incomplete.");
    if (source.querySelector("iframe")) warnings.push("Embedded frame contents are not extracted; only frame URLs are included.");
    if (media.some(item => !item.downloadable)) warnings.push("Blob and data media URLs cannot be fetched by download_media.");

    let content = clone.innerHTML;
    if (format === "text") {
      clone.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
      clone.querySelectorAll("p, div, section, article, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote")
        .forEach(node => node.append("\n"));
      clone.querySelectorAll("li").forEach(node => node.prepend("- "));
      clone.querySelectorAll("td, th").forEach(node => node.append("\t"));
      content = (clone.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    }
    return { content, links: links.slice(0, 100), media: media.slice(0, 100),
      links_truncated: links.length > 100, media_truncated: media.length > 100, warnings };
  }, { selectors: NOISE_SELECTORS, format });

  const originalLength = snapshot.content.length;
  return {
    ...snapshot, url, title, format,
    content: snapshot.content.slice(0, maxChars),
    captured_at: new Date().toISOString(),
    truncated: originalLength > maxChars,
    original_length: originalLength,
  };
}
