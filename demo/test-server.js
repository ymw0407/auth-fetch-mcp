#!/usr/bin/env node

// A simple test server with authentication to test auth-fetch-mcp
// Usage: node demo/test-server.js
// Then ask your AI: "Read http://localhost:3456/page using auth_fetch"
// Login: user / pass

const http = require("http");

const PORT = 3456;
const USERNAME = "user";
const PASSWORD = "pass";
const SESSION_TOKEN = "test-session-" + Date.now();

const sessions = new Set();

// Simple 1x1 blue PNG (valid image binary)
const BLUE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAe0lEQVR42u3QMQEAAAgD" +
    "oNm/tEV8IQSc1FVXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1" +
    "dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dX" +
    "V1dXV1fXVxfUtgABjPmVYwAAAABJRU5ErkJggg==",
  "base64"
);

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const [k, v] = c.trim().split("=");
    if (k) cookies[k] = v;
  });
  return cookies;
}

function isAuthenticated(req) {
  return sessions.has(parseCookies(req).session);
}

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

const LOGIN_PAGE = `<!DOCTYPE html>
<html>
<head><title>Login Required</title></head>
<body style="font-family:sans-serif; max-width:400px; margin:100px auto; text-align:center;">
  <h1>Login Required</h1>
  <p style="color:#666;">This page requires authentication.</p>
  <form method="POST" action="/login" style="margin-top:32px;">
    <input name="username" placeholder="Username" style="display:block; width:100%; padding:12px; margin:8px 0; box-sizing:border-box; border:1px solid #ccc; border-radius:6px;" />
    <input name="password" type="password" placeholder="Password" style="display:block; width:100%; padding:12px; margin:8px 0; box-sizing:border-box; border:1px solid #ccc; border-radius:6px;" />
    <button type="submit" style="width:100%; padding:12px; margin-top:12px; background:#2563eb; color:white; border:none; border-radius:6px; font-size:16px; cursor:pointer;">Sign In</button>
  </form>
  <p style="color:#999; margin-top:24px; font-size:14px;">Hint: user / pass</p>
</body>
</html>`;

const CONTENT_PAGE = `<!DOCTYPE html>
<html>
<head><title>Q1 2025 Product Roadmap</title></head>
<body style="font-family:sans-serif; max-width:700px; margin:40px auto; padding:0 20px;">
  <article>
    <h1>Q1 2025 Product Roadmap</h1>
    <p>Last updated: March 15, 2025 by the Product Team</p>

    <h2>Overview</h2>
    <p>This quarter we're focused on three major initiatives to improve our platform's capabilities and reach.</p>

    <h2>Initiatives</h2>

    <h3>1. Authentication MCP Server</h3>
    <p>Ship v2.0 with session persistence and multi-editor support. This enables AI assistants to read authenticated web pages seamlessly.</p>
    <p><strong>Status:</strong> <span style="color:green;">Shipped</span></p>
    <img src="http://localhost:${PORT}/images/architecture" alt="Architecture Diagram" width="400" />

    <h3>2. Browser Automation</h3>
    <p>Add support for single-page applications and dynamically rendered content. The wait_for parameter allows targeting specific elements.</p>
    <p><strong>Status:</strong> <span style="color:green;">Shipped</span></p>

    <h3>3. Multi-editor Support</h3>
    <p>Ensure compatibility with Claude Code, Cursor, Windsurf, and any MCP-compatible client.</p>
    <p><strong>Status:</strong> <span style="color:orange;">In Progress</span></p>
    <img src="http://localhost:${PORT}/images/editors" alt="Supported Editors" width="400" />

    <h2>Key Metrics</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse; width:100%;">
      <tr><th>Metric</th><th>Target</th><th>Current</th></tr>
      <tr><td>Weekly active users</td><td>1,000</td><td>847</td></tr>
      <tr><td>npm downloads</td><td>5,000/week</td><td>4,230/week</td></tr>
      <tr><td>GitHub stars</td><td>500</td><td>312</td></tr>
    </table>

    <h2>Video Demo</h2>
    <video src="http://localhost:${PORT}/video/demo" poster="http://localhost:${PORT}/images/poster" width="400" controls>
      Your browser does not support video.
    </video>

    <h2>Next Steps</h2>
    <ul>
      <li>Complete multi-editor testing by end of March</li>
      <li>Launch marketing campaign in April</li>
      <li>Begin Q2 planning with focus on enterprise features</li>
    </ul>
  </article>

  <footer style="margin-top:40px; padding-top:20px; border-top:1px solid #eee; color:#999;">
    <p>Confidential — Internal Use Only</p>
  </footer>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // POST /login — authenticate
  if (req.method === "POST" && url.pathname === "/login") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      if (
        params.get("username") === USERNAME &&
        params.get("password") === PASSWORD
      ) {
        sessions.add(SESSION_TOKEN);
        res.writeHead(302, {
          Location: "/page",
          "Set-Cookie": `session=${SESSION_TOKEN}; Path=/; HttpOnly`,
        });
        res.end();
      } else {
        send(res, 401, "text/html", "<h1>Invalid credentials</h1>");
      }
    });
    return;
  }

  // GET /page — protected content
  if (url.pathname === "/page") {
    if (!isAuthenticated(req)) {
      send(res, 200, "text/html", LOGIN_PAGE);
      return;
    }
    send(res, 200, "text/html", CONTENT_PAGE);
    return;
  }

  // GET /images/* — protected images (require session)
  if (url.pathname.startsWith("/images/")) {
    if (!isAuthenticated(req)) {
      send(res, 403, "text/plain", "Forbidden — login required");
      return;
    }
    send(res, 200, "image/png", BLUE_PNG);
    return;
  }

  // GET /video/* — protected video (require session)
  if (url.pathname.startsWith("/video/")) {
    if (!isAuthenticated(req)) {
      send(res, 403, "text/plain", "Forbidden — login required");
      return;
    }
    // Return a tiny valid mp4-like response
    send(res, 200, "video/mp4", Buffer.from("fake-video-content"));
    return;
  }

  // Default — redirect to /page
  res.writeHead(302, { Location: "/page" });
  res.end();
});

server.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────────┐
  │  Test server running at http://localhost:${PORT}    │
  │                                                   │
  │  Login: ${USERNAME} / ${PASSWORD}                            │
  │                                                   │
  │  Test steps:                                      │
  │  1. Ask AI to read http://localhost:${PORT}/page    │
  │     → auth_fetch opens browser                    │
  │     → Log in with user/pass                       │
  │     → Click Capture                               │
  │     → AI receives cleaned HTML                    │
  │                                                   │
  │  2. Ask AI to download an image from the HTML     │
  │     → download_media fetches with saved session   │
  │     → Image saved locally                         │
  │                                                   │
  │  Press Ctrl+C to stop                             │
  └─────────────────────────────────────────────────┘
`);
});
