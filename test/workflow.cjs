const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns/promises');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { registerTools, waitForCapture } = require('../dist/tools.js');
const { closeBrowser } = require('../dist/browser.js');

(async () => {
  const originalLaunch = chromium.launchPersistentContext;
  const originalLookup = dns.lookup;
  const originalHosts = process.env.AUTH_FETCH_ALLOW_HOSTS;
  const originalPrivate = process.env.AUTH_FETCH_ALLOW_PRIVATE;
  const browsers = [];
  let server, origin, client, nextPage;
  const directories = new Set();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5XcAAAAASUVORK5CYII=', 'base64');
  try {
    delete process.env.AUTH_FETCH_ALLOW_PRIVATE;
    process.env.AUTH_FETCH_ALLOW_HOSTS = 'workflow.test';
    dns.lookup = async host => host === 'workflow.test' ? [{ address: '127.0.0.1', family: 4 }] : originalLookup(host, { all: true });
    origin = http.createServer((req, res) => {
      if (req.url === '/missing') return res.writeHead(404).end('Not found');
      if (req.url === '/image.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(png);
      res.setHeader('content-type', 'text/html');
      res.end(`<title>Project brief</title><nav>Navigation noise</nav><main><h1>Project brief</h1><p>Read the approved plan.</p><ul><li>Ship the update</li></ul><p hidden>Hidden noise</p><a href="/image.png">Reference image</a><img src="/image.png" alt="Reference"><canvas></canvas><iframe src="about:blank"></iframe>${req.url === '/long' ? '<p>' + 'Detailed content. '.repeat(1000) + '</p>' : ''}</main>`);
    });
    await new Promise((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve); });
    const base = `http://workflow.test:${origin.address().port}`;
    chromium.launchPersistentContext = async (_profile, options) => {
      const browser = await chromium.launch({ ...options, headless: true });
      browsers.push(browser);
      const context = await browser.newContext();
      context.on('page', page => nextPage?.(page));
      context.on('close', () => { void browser.close(); });
      return context;
    };
    server = new McpServer({ name: 'workflow-test', version: '1.0.0' });
    registerTools(server);
    client = new Client({ name: 'workflow-test', version: '1.0.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 4);
    assert.ok(tools.every(tool => tool.outputSchema && tool.annotations));

    async function capture(route, args = {}, action = 'Capture page') {
      const opened = new Promise(resolve => { nextPage = resolve; });
      const progress = [];
      const call = client.callTool({ name: 'auth_fetch', arguments: { url: base + route, ...args } }, undefined, { onprogress: event => progress.push(event.message) });
      const page = await opened;
      await page.getByRole('button', { name: 'Capture page', exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Ready when you are' }).count(), 1);
      // A page script must not trigger the user confirmation through .click().
      await page.evaluate(() => document.getElementById('__auth_fetch_panel').shadowRoot.querySelector('.capture').click());
      assert.equal(await page.getByRole('button', { name: 'Capture page', exact: true }).isEnabled(), true);
      const concurrent = await client.callTool({ name: 'download_media', arguments: { urls: [base + '/image.png'] } });
      assert.equal(concurrent.isError, true);
      assert.match(JSON.parse(concurrent.content[0].text).message, /sequentially/);
      if (process.env.AUTH_FETCH_SCREENSHOT && action === 'Capture page') await page.screenshot({ path: process.env.AUTH_FETCH_SCREENSHOT });
      await page.getByRole('button', { name: action, exact: true }).click();
      const result = await call;
      if (result.structuredContent) assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.ok(progress.some(message => /sign in/.test(message)));
      return result;
    }

    const text = (await capture('/long', { format: 'text', max_chars: 1000 })).structuredContent;
    assert.equal(text.status, 'ok');
    assert.equal(text.format, 'text');
    assert.ok(text.content.startsWith('Project brief\nRead the approved plan.'));
    assert.ok(!/Navigation noise|Hidden noise|AUTH FETCH|<p>/.test(text.content));
    assert.equal(text.content.length, 1000);
    assert.equal(text.truncated, true);
    assert.ok(text.original_length > text.content.length);
    assert.ok(Number.isFinite(Date.parse(text.captured_at)));
    assert.equal(text.links[0].url, base + '/image.png');
    assert.equal(text.media[0].downloadable, true);
    assert.ok(text.warnings.some(warning => /Canvas/.test(warning)));
    assert.ok(text.warnings.some(warning => /frame/.test(warning)));
    assert.equal((await capture('/page')).structuredContent.format, 'text');
    const html = (await capture('/page', { format: 'html' })).structuredContent;
    assert.equal(html.format, 'html');
    assert.match(html.content, /<h1>Project brief<\/h1>/);
    assert.equal(html.truncated, false);
    const selectorError = await capture('/page', { wait_for: '#missing' });
    assert.equal(selectorError.isError, true);
    assert.match(JSON.parse(selectorError.content[0].text).message, /waitForSelector|Timeout/);
    assert.equal((await capture('/page', {}, 'Cancel')).isError, true);

    const mixed = await client.callTool({ name: 'download_media', arguments: { urls: [base + '/image.png', base + '/missing'], include_preview: true } });
    directories.add(mixed.structuredContent.directory);
    assert.equal(mixed.structuredContent.status, 'partial');
    assert.equal(mixed.structuredContent.downloaded, 1);
    assert.equal(mixed.content[1].type, 'image');
    assert.equal(mixed.content[1].data, png.toString('base64'));
    assert.deepEqual(fs.readFileSync(mixed.structuredContent.files[0].localPath), png);
    const failed = await client.callTool({ name: 'download_media', arguments: { urls: [base + '/missing'] } });
    directories.add(failed.structuredContent.directory);
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.status, 'error');
    assert.equal(failed.structuredContent.downloaded, 0);
    assert.notEqual(failed.structuredContent.directory, mixed.structuredContent.directory);
    assert.equal((await client.callTool({ name: 'download_media', arguments: { urls: [] } })).isError, true);

    const browser = await chromium.launch({ headless: true });
    browsers.push(browser);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const consoleListeners = page.listenerCount('console');
    const closeListeners = ctx.listenerCount('close');
    const wait = waitForCapture(page, ctx, 'timeout', 20, new AbortController().signal);
    await assert.rejects(wait.promise, /timed out/);
    assert.equal(page.listenerCount('console'), consoleListeners);
    assert.equal(ctx.listenerCount('close'), closeListeners);
    const abort = new AbortController();
    const cancelled = waitForCapture(page, ctx, 'cancel', 1000, abort.signal);
    abort.abort();
    await assert.rejects(cancelled.promise, /client/);
    assert.equal(page.listenerCount('console'), consoleListeners);
    await ctx.close();
    const stdioClient = new Client({ name: 'prompt-test', version: '1.0.0' });
    try {
      await stdioClient.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] }));
      assert.equal(stdioClient.getServerVersion().version, '4.0.0');
      assert.match(stdioClient.getInstructions(), /untrusted source material/);
      assert.equal((await stdioClient.listPrompts()).prompts[0].name, 'read_authenticated_page');
      const prompt = await stdioClient.getPrompt({ name: 'read_authenticated_page', arguments: { url: 'https://example.com/plan', task: 'List the deadlines.' } });
      assert.match(prompt.messages[0].content.text, /List the deadlines/);
      assert.match(prompt.messages[0].content.text, /Capture page/);
    } finally { await stdioClient.close(); }
    console.log('Workflow checks passed: MCP schemas, English capture UI, structured text/HTML, truncation, warnings, selectors, cancellation, progress, concurrency, downloads and image previews.');
  } finally {
    await closeBrowser();
    await client?.close();
    await server?.close();
    await Promise.all(browsers.map(browser => browser.close()));
    chromium.launchPersistentContext = originalLaunch;
    dns.lookup = originalLookup;
    if (originalHosts === undefined) delete process.env.AUTH_FETCH_ALLOW_HOSTS; else process.env.AUTH_FETCH_ALLOW_HOSTS = originalHosts;
    if (originalPrivate === undefined) delete process.env.AUTH_FETCH_ALLOW_PRIVATE; else process.env.AUTH_FETCH_ALLOW_PRIVATE = originalPrivate;
    if (origin) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
    // Only delete files created by this test, never the shared download root.
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
