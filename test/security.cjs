const assert = require('node:assert/strict');
const dns = require('node:dns/promises');
const http = require('node:http');
const net = require('node:net');
const { chromium } = require('playwright');
const { assertSafeUrl, resolveSafeHost } = require('../dist/security.js');
const { startSafeProxy } = require('../dist/proxy.js');
const { getOrLaunchBrowser, closeBrowser } = require('../dist/browser.js');

(async () => {
  const oldLookup = dns.lookup;
  const oldConnect = net.connect;
  const oldRequest = http.request;
  const oldLaunch = chromium.launchPersistentContext;
  const oldEnv = { ...process.env };
  let ctx, proxy, origin;
  try {
    delete process.env.AUTH_FETCH_ALLOW_PRIVATE;
    delete process.env.AUTH_FETCH_ALLOW_HOSTS;
    for (const host of ['127.0.0.1', '169.254.169.254', '[::1]', '[::ffff:127.0.0.1]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]', '[febf::1]', '[64:ff9b:1::1]']) {
      await assert.rejects(assertSafeUrl(`http://${host}/`), /Refusing/);
    }
    for (const url of ['file:///etc/passwd', 'data:text/plain,secret', 'javascript:alert(1)']) {
      await assert.rejects(assertSafeUrl(url), /Unsupported/);
    }
    let queries = 0;
    dns.lookup = async host => {
      if (host === 'rebind.test') return [{ address: ++queries === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
      if (host === 'mixed.test') return [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
      return [{ address: '127.0.0.1', family: 4 }];
    };
    process.env.AUTH_FETCH_ALLOW_HOSTS = '93.184.216.34';
    await assert.rejects(resolveSafeHost('mixed.test'), /Refusing/);
    process.env.AUTH_FETCH_ALLOW_HOSTS = 'public.test';
    let secrets = 0;
    origin = http.createServer((req, res) => {
      if (req.url === '/secret') secrets++;
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${origin.address().port}/secret` }).end();
      } else if (req.url === '/page') {
        res.setHeader('content-type', 'text/html');
        res.end(`<h1>public</h1><img src="http://127.0.0.1:${origin.address().port}/secret"><iframe src="/redirect"></iframe>`);
      } else res.end(req.headers.host + ' ' + (req.headers.cookie || ''));
    });
    origin.on('upgrade', (request, socket) => {
      if (request.url === '/secret') secrets++;
      const accept = require('node:crypto').createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 2, 111, 107]));
      socket.on('error', () => socket.destroy());
      socket.on('data', () => socket.destroy());
    });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    const port = origin.address().port;
    proxy = await startSafeProxy();
    // Use production launch options with an ephemeral context, keeping the
    // developer's persistent browser profile untouched.
    chromium.launchPersistentContext = async (_dir, options) => {
      assert.ok(options.proxy.server);
      const browser = await chromium.launch(options);
      const context = await browser.newContext({ serviceWorkers: options.serviceWorkers });
      context.on('close', () => browser.close());
      return context;
    };
    ctx = await getOrLaunchBrowser(false);
    const url = `http://public.test:${port}`;
    await ctx.addCookies([{ name: 'session', value: 'ok', url }]);
    assert.match(await (await ctx.request.get(url)).text(), /public.test.*session=ok/);
    const blocked = await ctx.request.get(`${url}/redirect`);
    assert.equal(blocked.status(), 403);
    const httpsBlocked = await ctx.request.get(`https://127.0.0.1:${port}/secret`, { timeout: 2000 }).catch(() => null);
    if (httpsBlocked) assert.equal(httpsBlocked.status(), 403);
    const page = await ctx.newPage();
    await page.goto(`${url}/page`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('h1').textContent(), 'public');
    await page.goto(`http://127.0.0.1:${port}/secret`);
    assert.equal(await page.locator('body').textContent(), 'Blocked destination');
    await assertSafeUrl(`http://rebind.test:${port}/secret`);
    assert.equal((await ctx.request.get(`http://rebind.test:${port}/secret`)).status(), 403);
    assert.equal(queries, 2);
    assert.equal(await page.evaluate(url => new Promise(resolve => {
      const ws = new WebSocket(url);
      ws.onmessage = event => { resolve(event.data); ws.close(); };
      ws.onerror = () => resolve('blocked');
    }), `ws://public.test:${port}/socket`), 'ok');
    assert.equal(await page.evaluate(url => new Promise(resolve => {
      const ws = new WebSocket(url);
      ws.onopen = () => { resolve('unsafe'); ws.close(); };
      ws.onerror = () => resolve('blocked');
    }), `ws://127.0.0.1:${port}/secret`), 'blocked');
    assert.equal(secrets, 0);

    // Playwright's request context uses CONNECT even for HTTP. Observe the
    // checked IP at the TCP boundary, then map it to our local fixture.
    queries = 0;
    let pinned = 0;
    net.connect = (options, ...args) => {
      if (options.host === '93.184.216.34') {
        pinned++;
        return oldConnect({ ...options, host: '127.0.0.1' }, ...args);
      }
      return oldConnect(options, ...args);
    };
    assert.match(await (await ctx.request.get(`http://rebind.test:${port}/pin`, { timeout: 3000 })).text(), /rebind.test/);
    assert.equal(queries, 1);
    assert.equal(pinned, 1);
    net.connect = oldConnect;

    // Chromium's HTTP forwarding also connects to the checked IP, with Host
    // unchanged. Use another page so no prior proxy connection is reused.
    queries = 0;
    pinned = 0;
    http.request = (options, ...args) => {
      if (options.hostname === '93.184.216.34') {
        pinned++;
        assert.match(options.headers.host, /rebind.test/);
        return oldRequest({ ...options, hostname: '127.0.0.1' }, ...args);
      }
      return oldRequest(options, ...args);
    };
    await page.goto(`http://rebind.test:${port}/browser-pin`);
    assert.match(await page.locator('body').textContent(), /rebind.test/);
    assert.equal(queries, 1);
    assert.equal(pinned, 1);
    http.request = oldRequest;

    // CONNECT tunnels use the same validated resolver, preserving the original
    // hostname for the client's TLS/SNI rather than rewriting the HTTPS URL.
    const tunnel = net.connect(Number(new URL(proxy.url).port), '127.0.0.1');
    tunnel.write(`CONNECT public.test:${port} HTTP/1.1\r\nHost: public.test:${port}\r\n\r\n`);
    const reply = await new Promise(resolve => tunnel.once('data', resolve));
    assert.match(reply.toString(), /200 Connection Established/);
    tunnel.destroy();
    assert.equal(secrets, 0);
    console.log('Security checks passed: IP forms, mixed DNS, rebinding, IP pinning, redirects, browser subresources, CONNECT, cookies.');
  } finally {
    http.request = oldRequest;
    net.connect = oldConnect;
    dns.lookup = oldLookup;
    if (ctx) await closeBrowser();
    chromium.launchPersistentContext = oldLaunch;
    proxy?.close();
    if (origin) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
    for (const key of ['AUTH_FETCH_ALLOW_PRIVATE', 'AUTH_FETCH_ALLOW_HOSTS']) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
