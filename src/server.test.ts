import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ServerOptions } from "./server.js";
import { InfomaniakClient } from "./infomaniak-client.js";
import { MailClient } from "./mail-client.js";
import { policyFromEnv } from "./tool-policy.js";

const mockFetch = vi.fn();

async function connect(options: ServerOptions) {
  const server = createMcpServer(
    {
      client: new InfomaniakClient({ token: "t", maxAttempts: 1 }),
      mailClient: new MailClient("t"),
    },
    options,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP server with the default policy", () => {
  it("advertises read tools and hides writes and dangerous tools", async () => {
    const client = await connect({ policy: policyFromEnv({}) });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("infomaniak_mail_read_email");
    expect(names).toContain("infomaniak_kdrive_download_file");
    expect(names).not.toContain("infomaniak_renew_domain");
    expect(names).not.toContain("infomaniak_kdrive_upload_file");
  });

  it("refuses a hidden tool without calling the API", async () => {
    const client = await connect({ policy: policyFromEnv({}) });
    const result = await client.callTool({ name: "infomaniak_renew_domain", arguments: { domain: "example.com" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/refused/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("KDRIVE_ID default", () => {
  it("makes drive_id optional and fills it in", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ result: "success", data: [] }) });
    const client = await connect({ policy: policyFromEnv({}), defaultDriveId: 99 });

    const listTool = (await client.listTools()).tools.find((t) => t.name === "infomaniak_list_kdrive_files");
    expect(listTool?.inputSchema.required ?? []).not.toContain("drive_id");

    const result = await client.callTool({ name: "infomaniak_list_kdrive_files", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(mockFetch.mock.calls[0][0]).toBe("https://api.infomaniak.com/3/drive/99/files/1/files");
  });
});
