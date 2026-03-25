#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { closeBrowser } from "./browser.js";

const server = new McpServer(
  {
    name: "auth-fetch",
    version: "2.0.0",
  },
  {
    instructions:
      "When a user asks to read, summarize, or access a URL and Fetch/web_fetch returns " +
      "a login page, empty HTML shell, or minimal content (especially from Notion, Google Docs, " +
      "Jira, Confluence, Linear, Slack, or any SaaS platform), you MUST use the auth_fetch tool " +
      "to open a real browser for the user to log in. Do NOT suggest copy-paste, PDF export, or " +
      "other manual workarounds before trying auth_fetch first.",
  }
);

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const cleanup = async () => {
    await closeBrowser();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
