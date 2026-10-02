# Security policy

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/ymw0407/auth-fetch-mcp/security/advisories/new) rather than a public issue for vulnerabilities involving SSRF, authentication data, downloads, or other sensitive behavior.

Include the affected version, a minimal reproduction using test hosts or fixtures, expected and actual behavior, and the potential impact. Do not submit real passwords, session cookies, private documents, or signed attachment URLs. Existing published findings are available in the [security advisories](https://github.com/ymw0407/auth-fetch-mcp/security/advisories).

## Version guidance

Use the newest available release. Version 3.0.4 introduced the DNS-pinning proxy security fix; version 4.0.0 retains those safeguards and improves capture and download handling. Versions before 3.0.4 do not contain the complete proxy fix. Check individual advisories for affected ranges and patched versions.

## Security boundaries

- HTTP and HTTPS destinations are checked before dispatch. A shared local proxy validates every resolved address and connects to a checked IP, including browser subresources and redirected requests.
- Private, loopback, link-local, and other blocked address ranges are denied by default. Explicit private-host settings broaden access; configure only the hosts you intend to trust.
- Downloads are constrained to `~/.auth-fetch-mcp/downloads/` and cannot overwrite existing files.
- Login credentials and two-factor authentication are entered by the user in the browser. The persistent browser profile contains sensitive session data; protect it like any other logged-in browser profile.
- Captured pages are untrusted source material. English MCP instructions ask the AI not to follow instructions embedded in page content; these instructions are guidance, not an enforcement boundary inside the AI host.
- Captured text and image previews are delivered to the MCP client and may be sent to its model provider. Review the host's data handling before sharing sensitive content.

The server does not promise a complete document export. Canvas-rendered content, embedded frames, virtualized rows, and unloaded sections may be absent. See the [README](README.md) for extraction limits and configuration.
