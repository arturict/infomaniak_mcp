#!/usr/bin/env node

/**
 * Infomaniak MCP Server
 *
 * A Model Context Protocol server that provides tools for interacting
 * with the Infomaniak API - managing domains, email, hosting, kDrive, and more.
 *
 * Main environment variables (full list in README.md):
 * - INFOMANIAK_API_TOKEN: Your Infomaniak API token (required)
 * - INFOMANIAK_TOOLSETS, INFOMANIAK_ALLOW_WRITES, INFOMANIAK_ALLOW_DANGEROUS,
 *   INFOMANIAK_ENABLE_MAIL_SEND: which tools are listed and callable
 * - MCP_TRANSPORT: Transport mode - 'stdio' (default) or 'http'
 * - MCP_AUTH_TOKEN: Bearer token required on /mcp in http mode
 *
 * Get your API token from: https://manager.infomaniak.com/v3/ng/accounts/token/list
 */

import { InfomaniakClient } from "./infomaniak-client.js";
import { KChatClient } from "./kchat-client.js";
import { MailClient } from "./mail-client.js";
import { createMcpServer } from "./server.js";
import { policyFromEnv, type ToolPolicy } from "./tool-policy.js";
import { startStdioServer } from "./transports/stdio.js";
import { parseCorsOrigins, startHttpServer } from "./transports/http.js";

// Get API token from environment
const API_TOKEN = process.env.INFOMANIAK_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: INFOMANIAK_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://manager.infomaniak.com/v3/ng/accounts/token/list");
  process.exit(1);
}

// Initialize the Infomaniak client
const client = new InfomaniakClient({ token: API_TOKEN });

// Optionally initialize the kChat client
const kchatHost = process.env.KCHAT_HOST;
const kchatToken = process.env.KCHAT_TOKEN;
const kchatClient = (kchatHost && kchatToken)
  ? new KChatClient({ host: kchatHost, token: kchatToken })
  : null;

// Mail client (user-side mail API). Created once so its draft cache is shared
// by every HTTP session; it contacts the API only when a mail tool runs.
// INFOMANIAK_MAIL_TOKEN allows a separate token with the workspace:mail scope.
const mailClient = new MailClient(process.env.INFOMANIAK_MAIL_TOKEN || API_TOKEN, {
  defaultMailbox: process.env.INFOMANIAK_MAIL_MAILBOX,
});

const deps = { client, mailClient, kchatClient };

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

let policy: ToolPolicy;
try {
  policy = policyFromEnv(process.env);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const rawDriveId = process.env.KDRIVE_ID?.trim();
const defaultDriveId = rawDriveId ? Number(rawDriveId) : undefined;
if (defaultDriveId !== undefined && !(Number.isInteger(defaultDriveId) && defaultDriveId > 0)) {
  fail("KDRIVE_ID must be a positive integer");
}

// Get transport configuration from environment
const transport = process.env.MCP_TRANSPORT || "stdio";

if (transport === "http" && !process.env.MCP_AUTH_TOKEN && process.env.MCP_ALLOW_NO_AUTH !== "true") {
  fail("MCP_AUTH_TOKEN is required for the HTTP transport. Set MCP_ALLOW_NO_AUTH=true only behind a proxy that authenticates.");
}

const serverOptions = { policy, defaultDriveId };
const createServer = () => createMcpServer(deps, serverOptions);

const port = parseInt(process.env.PORT || process.env.MCP_PORT || "3000", 10);
const stateless = process.env.MCP_STATELESS === "true";

// Start the server with the selected transport
async function main() {
  if (transport === "http") {
    await startHttpServer(createServer, {
      port,
      stateless,
      host: process.env.MCP_HOST || undefined,
      authToken: process.env.MCP_AUTH_TOKEN || undefined,
      allowNoAuth: process.env.MCP_ALLOW_NO_AUTH === "true",
      corsOrigins: parseCorsOrigins(process.env.MCP_CORS_ORIGINS),
    });
  } else if (transport === "stdio") {
    await startStdioServer(createServer);
  } else {
    console.error(`Error: Unknown transport '${transport}'. Use 'stdio' or 'http'.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
