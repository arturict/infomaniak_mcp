/**
 * Tests for the HTTP transport against the real Express app and MCP server.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { createHttpApp, parseCorsOrigins, type HttpServerOptions } from "./http.js";
import { createMcpServer } from "../server.js";
import { InfomaniakClient } from "../infomaniak-client.js";
import { MailClient } from "../mail-client.js";
import { policyFromEnv } from "../tool-policy.js";

const TOKEN = "test-secret-token";
const ACCEPT = "application/json, text/event-stream";

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
};

function app(options: HttpServerOptions = { authToken: TOKEN }) {
  const createServer = () =>
    createMcpServer(
      { client: new InfomaniakClient({ token: "t" }), mailClient: new MailClient("t") },
      { policy: policyFromEnv({}) },
    );
  return createHttpApp(createServer, options);
}

/** Responses arrive as SSE; return the JSON of the first data line. */
function sseJson(text: string): { result?: { tools?: { name: string }[] } } {
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  if (!line) throw new Error(`No SSE data in: ${text}`);
  return JSON.parse(line.slice(6));
}

describe("startup", () => {
  it("refuses to build without a token unless no-auth is explicitly allowed", () => {
    expect(() => app({})).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => app({ allowNoAuth: true })).not.toThrow();
  });
});

describe("/health", () => {
  it("answers without authentication and reveals no configuration", async () => {
    const res = await request(app()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("bearer authentication", () => {
  it("rejects /mcp without or with a wrong token", async () => {
    const a = app();
    expect((await request(a).post("/mcp").set("Accept", ACCEPT).send(initialize)).status).toBe(401);
    expect((await request(a).post("/mcp").set("Authorization", "Bearer nope").send(initialize)).status).toBe(401);
    expect((await request(a).get("/mcp")).status).toBe(401);
    expect((await request(a).delete("/mcp")).status).toBe(401);
  });

  it("no longer exposes a session listing", async () => {
    const res = await request(app()).get("/mcp/sessions").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).not.toBe(200);
  });

  it("initializes and lists tools with the right token", async () => {
    const a = app();
    const init = await request(a)
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .send(initialize);
    expect(init.status).toBe(200);
    const sessionId = init.headers["mcp-session-id"];
    expect(sessionId).toBeTruthy();

    await request(a)
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sessionId)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await request(a)
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", sessionId)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.status).toBe(200);
    const names = sseJson(list.text).result?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("infomaniak_mail_list_emails");
    expect(names).not.toContain("infomaniak_renew_domain");
  });

  it("returns 404 for an unknown session", async () => {
    const res = await request(app())
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .set("Mcp-Session-Id", "unknown")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(404);
  });
});

describe("CORS", () => {
  it("sends no CORS headers by default", async () => {
    const res = await request(app()).options("/mcp").set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflights for configured origins without requiring the token", async () => {
    const res = await request(app({ authToken: TOKEN, corsOrigins: ["https://app.example.com"] }))
      .options("/mcp")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(res.headers["access-control-allow-headers"]).toMatch(/Authorization/);
  });

  it("parses MCP_CORS_ORIGINS", () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins(" https://a.example.com, ,https://b.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });
});

describe("stateless mode", () => {
  it("serves tools/list without a session", async () => {
    const res = await request(app({ authToken: TOKEN, stateless: true }))
      .post("/mcp")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("Accept", ACCEPT)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(sseJson(res.text).result?.tools?.length).toBeGreaterThan(0);
  });
});
