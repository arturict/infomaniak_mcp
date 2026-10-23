/**
 * Stdio Transport Module
 *
 * Provides stdio-based transport for the MCP server.
 * This is the default transport mode for CLI-based MCP clients like Claude Desktop.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type ServerDeps } from "../server.js";

/**
 * Start the MCP server with stdio transport
 *
 * @param deps - API clients used by the tools
 */
export async function startStdioServer(deps: ServerDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error("Infomaniak MCP Server running on stdio");
}
