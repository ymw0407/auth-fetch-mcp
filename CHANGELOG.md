# Changelog

## 4.0.0

[Release notes](https://github.com/ymw0407/auth-fetch-mcp/releases/tag/v4.0.0) · [Implementation PR](https://github.com/ymw0407/auth-fetch-mcp/pull/27)

### Changed

- Default capture output is readable text, limited to 20,000 characters. Request `format: "html"` and `max_chars: 100000` for the previous content format and limit.
- English server guidance and a reusable `read_authenticated_page` MCP prompt explain human approval, untrusted page content, source citations, and attachment handling.
- Redesigned English capture panel provides accessible Capture page and Cancel controls with isolated styles.
- Capture results include structured source metadata, links, media, truncation flags, and extraction warnings, alongside compatible JSON text.
- Capture waits are bounded and cancellable, with progress notifications when requested by the client. Captures and downloads run sequentially.
- Missing `wait_for` selectors now fail rather than being silently ignored.
- Downloads report counts and per-file failures, optionally return small image previews, create unique default directories, and refuse overwrites.
- README explains client timeouts, extraction limits, migration, and the actual privacy boundary.
- Security regressions and a real Chromium/MCP workflow are checked in CI.

### Migration

Configure the client's tool timeout to cover browser startup and navigation in addition to the default 600-second capture wait. Inspect `truncated` and `warnings` before claiming the document is complete. Inspect `downloaded` and individual errors before reporting successful downloads. A local file path does not give the AI image content.

The DNS-pinning proxy and URL/path safeguards from 3.0.4 remain enabled.

## 3.0.4

[Security fix PR](https://github.com/ymw0407/auth-fetch-mcp/pull/26)

- Added a shared validated proxy for browser traffic and downloads that connects directly to checked DNS addresses, closing DNS rebinding bypasses.
- Strengthened private-address checks for mixed DNS answers, IPv6 link-local addresses, and NAT64 local-use addresses.
- Updated dependencies and added security regression checks.

Earlier releases are listed in [GitHub Releases](https://github.com/ymw0407/auth-fetch-mcp/releases).
