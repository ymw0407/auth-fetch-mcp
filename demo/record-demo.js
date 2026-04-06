#!/usr/bin/env node

// Records the split-screen product demo as video
// Usage: node demo/record-demo.js
// Output: demo/product-demo.webm → convert with ffmpeg

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const OUTPUT_DIR = path.join(__dirname, "videos");
const HTML_PATH = path.join(__dirname, "demo-presentation.html");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: {
      dir: OUTPUT_DIR,
      size: { width: 1280, height: 720 },
    },
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();
  console.log("Recording demo...");

  await page.goto(`file:///${HTML_PATH.replace(/\\/g, "/")}`);

  // Wait for the presentation to signal it's done
  await page.waitForFunction(
    () => document.title === "__RECORDING_DONE__",
    null,
    { timeout: 120000 }
  );

  // Small buffer at the end
  await page.waitForTimeout(1000);

  await context.close();
  await browser.close();

  // Find and rename the output
  const files = fs.readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".webm"));
  if (files.length > 0) {
    const src = path.join(OUTPUT_DIR, files[files.length - 1]);
    const dst = path.join(__dirname, "product-demo.webm");
    fs.copyFileSync(src, dst);
    console.log(`\nSaved: ${dst}`);
    console.log(`\nConvert to MP4:`);
    console.log(`  ffmpeg -i demo/product-demo.webm -c:v libx264 -pix_fmt yuv420p demo/product-demo.mp4`);
    console.log(`\nConvert to GIF:`);
    console.log(`  ffmpeg -i demo/product-demo.webm -vf "fps=15,scale=960:-1" demo/product-demo.gif`);
  }
}

main().catch(console.error);
