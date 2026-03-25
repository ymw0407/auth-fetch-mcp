# auth-fetch-mcp

MCP server that lets AI assistants fetch content from authenticated web pages.

When your AI tries to read a URL that requires login, this tool opens a real browser for you to sign in — then captures the page content. Sessions are saved locally, so you only log in once per service.

## Quick Start

### Claude Code

```bash
claude mcp add auth-fetch -- npx auth-fetch-mcp@latest
```

### .mcp.json (Cursor, Windsurf, etc.)

```json
{
  "mcpServers": {
    "auth-fetch": {
      "command": "npx",
      "args": ["auth-fetch-mcp@latest"]
    }
  }
}
```

Chromium is auto-installed on first run if not already present.

## How It Works

1. Ask your AI to read any authenticated page — just paste the URL.
2. If login is required, a browser window opens automatically.
3. Log in as you normally would (supports SSO, 2FA, CAPTCHA — anything).
4. Tell your AI "done" — it captures the page content instantly.
5. Next time, the same site works without logging in again.

## Tools

### `auth_fetch`

The primary tool. Fetches page content, opening a browser for login if needed.

| Parameter  | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `url`     | string | yes      | The URL to fetch content from |
| `wait_for`| string | no       | CSS selector to wait for before capturing (useful for SPAs) |

**Flow:**
- If a saved session exists → fetches content silently (no browser window)
- If no session or session expired → opens a browser for manual login
- Call again after login to capture the content

### `list_pages`

Lists all open tabs in the browser with their URLs and titles.

### `close_browser`

Closes the browser window. Login sessions are saved and will be reused next time.

## How Sessions Work

Login sessions are saved to `~/.auth-fetch-mcp/browser-data/`. This is a standard Chromium profile directory containing cookies and local storage. Sessions persist across restarts.

To clear all sessions:
```bash
rm -rf ~/.auth-fetch-mcp/browser-data/
```

## Supported AI Tools

- Claude Code
- Cursor
- Windsurf
- Any MCP-compatible client using stdio transport

## Limitations

- Requires a local environment (does not work in web-based chat interfaces)
- First access to each service requires manual login
- Very long pages are truncated to fit LLM context windows (50K chars)
- Some sites with aggressive bot detection may not work (try the `wait_for` option)

## Privacy

- All data stays on your machine — nothing is sent to external servers
- Browser sessions are stored locally in your home directory
- The MCP server only communicates with the AI tool via stdio (local pipe)

## License

MIT
