import { describe, it, expect, vi, beforeEach } from "vitest";
import { MailClient, draftPayloadFromApi } from "./mail-client.js";

const API = "https://mail.example.com/api";
const MANAGER = "https://manager.example.com/1";

type Route = (url: string, init: RequestInit) => unknown;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function respondWith(routes: Record<string, Route>) {
  mockFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const key = Object.keys(routes).find((k) => {
      const [m, prefix] = k.split(" ");
      return m === method && url.startsWith(prefix);
    });
    if (!key) return new Response("not found", { status: 404 });
    return Response.json({ result: "success", data: routes[key](url, init) });
  });
}

const mailboxes = () => [
  { uuid: "uuid-1", email: "info@example.com", mailbox: "info", hosting_id: 7, aliases: ["hello@example.com"] },
  { uuid: "uuid-2", email: "team@example.com", mailbox: "team", hosting_id: 7, aliases: [] },
];

function client(defaultMailbox?: string) {
  return new MailClient("token", { mailApiBase: API, managerApiBase: MANAGER, defaultMailbox });
}

function calls(method: string) {
  return mockFetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("mailbox selection", () => {
  it("uses the first mailbox without a selector or default", async () => {
    respondWith({ [`GET ${API}/mailbox`]: mailboxes });
    expect((await client().resolveMailbox()).uuid).toBe("uuid-1");
  });

  it("uses the configured default by email, case-insensitively", async () => {
    respondWith({ [`GET ${API}/mailbox`]: mailboxes });
    expect((await client("TEAM@example.com").resolveMailbox()).uuid).toBe("uuid-2");
  });

  it("lets a tool argument pick a mailbox by UUID and rejects unknown ones", async () => {
    respondWith({ [`GET ${API}/mailbox`]: mailboxes });
    const c = client("team@example.com");
    expect((await c.resolveMailbox("uuid-1")).email).toBe("info@example.com");
    await expect(c.resolveMailbox("nobody@example.com")).rejects.toThrow(/not found/);
  });
});

describe("reading", () => {
  it("returns an HTML body as truncated plain text with a reply id", async () => {
    respondWith({
      [`GET ${API}/mail/uuid-1/folder/F1/message/42`]: () => ({
        uid: "42@F1",
        msg_id: "<m42@example.com>",
        subject: "Offerte",
        from: [{ name: "Client", email: "client@example.com" }],
        body: { type: "text/html", value: "<p>Hello <b>there</b></p><p>Second paragraph</p>" },
        attachments: [{ resource: "/api/mail/uuid-1/folder/F1/message/42/attachment/2", name: "a.pdf", mime_type: "application/pdf", size: 10 }],
      }),
    });
    const email = await client().readEmail("uuid-1", "F1", "42", { format: "text", maxChars: 11 });
    expect(email).toMatchObject({
      uid: "42",
      reply_to_uid: "42@F1",
      from: "Client <client@example.com>",
      body: "Hello there",
      body_truncated: true,
      attachments: [{ id: "2", filename: "a.pdf" }],
    });
  });

  it("refuses to combine unseen and flagged filters", async () => {
    await expect(client().listEmails("uuid-1", "F1", { limit: 5, offset: 0, unseen: true, flagged: true }))
      .rejects.toThrow(/one filter/);
  });
});

describe("drafts", () => {
  it("creates a threaded reply draft and updates it from the saved payload", async () => {
    respondWith({
      [`GET ${API}/mailbox`]: mailboxes,
      [`GET ${MANAGER}/mail_hostings/7/mailboxes/info/signatures`]: () => ({
        signatures: [{ id: 3, sender: "info@example.com", full_name: "Example AG", is_default: true }],
      }),
      [`GET ${API}/mail/uuid-1/folder/F1/message/42`]: () => ({
        msg_id: "<m42@example.com>",
        headers: { references: "<m1@example.com>" },
      }),
      [`POST ${API}/mail/uuid-1/draft`]: () => ({ uuid: "d-1", uid: "900" }),
      [`PUT ${API}/mail/uuid-1/draft/d-1`]: () => ({ uid: "901" }),
    });
    const c = client();

    const draft = await c.createDraft(undefined, {
      to: "client@example.com",
      subject: "Re: Offerte",
      body: "Danke <3",
      inReplyToUid: "42@F1",
    });
    expect(draft).toMatchObject({ draft_uuid: "d-1", resolved_from: { name: "Example AG", identity_id: "3" } });

    const created = JSON.parse(String(calls("POST")[0][1].body));
    expect(created).toMatchObject({
      in_reply_to: "<m42@example.com>",
      references: "<m1@example.com> <m42@example.com>",
      to: [{ name: "", email: "client@example.com" }],
      action: "save",
    });
    expect(created.body).toContain("Danke &lt;3");

    await c.updateDraft("uuid-1", "d-1", { subject: "Re: Offerte (v2)" });
    const updated = JSON.parse(String(calls("PUT")[0][1].body));
    expect(updated).toMatchObject({
      subject: "Re: Offerte (v2)",
      in_reply_to: "<m42@example.com>",
      identity_id: "3",
      action: "save",
    });
  });

  it("never saves over a draft it cannot read completely", async () => {
    respondWith({
      [`GET ${API}/mail/uuid-1/draft/unknown`]: () => ({ subject: "x", to: "not-a-list" }),
    });
    await expect(client().updateDraft("uuid-1", "unknown", { subject: "y" })).rejects.toThrow(/create a new draft/);
    expect(calls("PUT")).toHaveLength(0);
  });
});

describe("draftPayloadFromApi", () => {
  it("accepts a draft whose fields can all be read", () => {
    const payload = draftPayloadFromApi({
      subject: "Hi",
      body: "<p>x</p>",
      from: [{ name: "A", email: "a@example.com" }],
      to: [{ email: "b@example.com" }],
      cc: null,
      bcc: [],
      attachments: [{ uuid: "att-1" }],
    }, "d-9");
    expect(payload).toMatchObject({ uuid: "d-9", attachments: ["att-1"], to: [{ name: "", email: "b@example.com" }] });
  });

  it("takes the sender from the resolved identity when the draft has no from field", () => {
    // Shape returned by GET /mail/{mailbox}/draft/{uuid} (observed 2026-10-23).
    const data = { subject: "Hi", body: "<p>x</p>", identity_id: "42", to: [{ email: "b@example.com", name: "" }], cc: [], bcc: [], attachments: [] };
    expect(draftPayloadFromApi(data, "d-1")).toBeNull();
    expect(draftPayloadFromApi(data, "d-1", { name: "A", email: "a@example.com" })).toMatchObject({
      from: { email: "a@example.com" },
      identity_id: "42",
      cc: null,
      bcc: null,
    });
  });
});
