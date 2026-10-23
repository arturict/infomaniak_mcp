/**
 * HTTP Transport Module
 *
 * Serves the MCP Streamable HTTP transport on /mcp.
 *
 * Every /mcp request must carry `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 * The server refuses to start without a token unless MCP_ALLOW_NO_AUTH=true,
 * because anyone who can reach it would otherwise act with the Infomaniak
 * token. /health stays open and returns no configuration.
 *
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface HttpServerOptions {
  /** Port to listen on (default: 3000) */
  port?: number;
  /** Host to bind to (default: 0.0.0.0) */
  host?: string;
  /** Create a fresh server for every request instead of keeping sessions */
  stateless?: boolean;
  /** Bearer token clients must present on /mcp */
  authToken?: string;
  /** Start without a token. Only for a trusted network or a fronting proxy that authenticates. */
  allowNoAuth?: boolean;
  /** Browser origins allowed by CORS (default: none, no CORS headers) */
  corsOrigins?: string[];
}

/**
 * Request bodies carry base64 file content for kDrive uploads and mail
 * attachments (10 MB raw, about 13.4 MB as base64) plus JSON overhead.
 */
const MAX_BODY = "15mb";

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

/**
 * Compare SHA-256 digests so timingSafeEqual always sees equal lengths and
 * the comparison time does not depend on the token length or content.
 */
function bearerAuth(token: string) {
  const expected = createHash("sha256").update(token).digest();
  return (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    const presented = createHash("sha256").update(match ? match[1].trim() : "").digest();
    if (match && timingSafeEqual(presented, expected)) {
      next();
      return;
    }
    res.setHeader("WWW-Authenticate", 'Bearer realm="mcp"');
    jsonRpcError(res, 401, -32001, "Unauthorized");
  };
}

/** Parse MCP_CORS_ORIGINS: comma-separated origins; empty means no CORS. */
export function parseCorsOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * Build the Express app. Exported so tests exercise the real routes.
 *
 * @param createServer - Builds a configured MCP server for a session or request
 */
export function createHttpApp(createServer: () => Server, options: HttpServerOptions = {}): Express {
  const stateless = options.stateless ?? false;
  const corsOrigins = options.corsOrigins ?? [];
  if (!options.authToken && !options.allowNoAuth) {
    throw new Error("MCP_AUTH_TOKEN is required for the HTTP transport (or set MCP_ALLOW_NO_AUTH=true)");
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const app = express();

  // CORS runs before auth: browser preflights carry no Authorization header.
  if (corsOrigins.length > 0) {
    app.use(cors({
      origin: corsOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
      exposedHeaders: ["Mcp-Session-Id"],
    }));
  }

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  if (options.authToken) {
    app.use("/mcp", bearerAuth(options.authToken));
  }
  app.use(express.json({ limit: MAX_BODY }));

  async function handle(transport: StreamableHTTPServerTransport, req: Request, res: Response): Promise<void> {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request error:", error instanceof Error ? error.message : String(error));
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    if (stateless) {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await handle(transport, req, res);
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const transport = sessions.get(sessionId);
      if (!transport) {
        jsonRpcError(res, 404, -32001, "Session not found");
        return;
      }
      await handle(transport, req, res);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32600, "Invalid request: No session ID provided and not an initialization request");
      return;
    }

    const newSessionId = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId });
    sessions.set(newSessionId, transport);
    transport.onclose = () => {
      sessions.delete(newSessionId);
    };
    await createServer().connect(transport);
    await handle(transport, req, res);
  });

  // GET opens the server-to-client SSE stream; DELETE ends a session.
  const sessionRoute = async (req: Request, res: Response) => {
    if (stateless) {
      jsonRpcError(res, 405, -32000, "Method not allowed in stateless mode");
      return;
    }
    const sessionId = req.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (!transport) {
      jsonRpcError(res, typeof sessionId === "string" ? 404 : 400, -32600, "Session not found");
      return;
    }
    await handle(transport, req, res);
  };
  app.get("/mcp", sessionRoute);
  app.delete("/mcp", sessionRoute);

  return app;
}

/**
 * Start the MCP server with HTTP transport.
 *
 * @param createServer - Builds a configured MCP server for each session
 * @param options - HTTP server configuration options
 */
export async function startHttpServer(createServer: () => Server, options: HttpServerOptions = {}): Promise<void> {
  const port = options.port ?? 3000;
  const host = options.host ?? "0.0.0.0";
  const app = createHttpApp(createServer, options);

  if (!options.authToken) {
    console.error("Warning: MCP_ALLOW_NO_AUTH=true, /mcp accepts requests without authentication");
  }

  await new Promise<void>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve());
    listener.on("error", reject);
  });
  console.error(`Infomaniak MCP Server running on http://${host}:${port}/mcp`);
  console.error(`Mode: ${options.stateless ? "stateless" : "stateful"}`);
}
