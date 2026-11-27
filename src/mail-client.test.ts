import { describe, it, expect, vi, beforeEach } from "vitest";
import { MailClient, draftPayloadFromApi, createHtmlBody, bodyHasSignature, pickSignature } from "./mail-client.js";

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

  it("returns Bcc and the threading headers, and null where the API gave no Bcc", async () => {
    respondWith({
      [`GET ${API}/mail/uuid-1/folder/S1/message/7`]: () => ({
        uid: "7@S1",
        msg_id: "<m7@example.com>",
        subject: "Re: Offerte",
        to: [{ name: "", email: "client@example.com" }],
        cc: [],
        bcc: [{ name: "Archiv", email: "archiv@example.com" }],
        in_reply_to: "<m42@example.com>",
        references: "<m1@example.com> <m42@example.com>",
        body: { type: "text/plain", value: "Danke" },
      }),
      [`GET ${API}/mail/uuid-1/folder/S1/message/8`]: () => ({ uid: "8@S1", subject: "x", body: { type: "text/plain", value: "y" } }),
    });
    const c = client();
    expect(await c.readEmail("uuid-1", "S1", "7", { format: "text", maxChars: 100 })).toMatchObject({
      cc: "",
      bcc: "Archiv <archiv@example.com>",
      in_reply_to: "<m42@example.com>",
      references: "<m1@example.com> <m42@example.com>",
    });
    expect(await c.readEmail("uuid-1", "S1", "8", { format: "text", maxChars: 100 })).toMatchObject({ bcc: null, in_reply_to: null });
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

const SIGNATURE = '<table><tr><td><img src="https://example.com/a.png" alt="A"></td><td><div>Artur Ferreira</div><div>Gründer, Example</div></td></tr></table>';

function signatureRoutes(extra: Record<string, Route> = {}) {
  return {
    [`GET ${API}/mailbox`]: mailboxes,
    [`GET ${MANAGER}/mail_hostings/7/mailboxes/info/signatures`]: () => ({
      signatures: [
        { id: 1, sender: null, full_name: "Artur", content: "<div>old</div>", is_default: false },
        { id: 3, sender: null, name: "Standard", full_name: "Artur", content: SIGNATURE, is_default: true },
      ],
      default_signature_id: 3,
      default_reply_signature_id: 3,
    }),
    [`POST ${API}/mail/uuid-1/draft`]: () => ({ uuid: "d-1", uid: "900" }),
    [`PUT ${API}/mail/uuid-1/draft/d-1`]: () => ({ uid: "901" }),
    ...extra,
  };
}

describe("draft body and signature", () => {
  it("renders paragraphs, line breaks and links, then the signature", () => {
    const html = createHtmlBody("Hallo <b>\nZeile 2\n\nSiehe https://a.example/x?y=1&z=2.", SIGNATURE);
    expect(html).toContain("<p");
    expect(html).toContain("Hallo &lt;b&gt;<br>Zeile 2</p>");
    expect(html).toContain('<a href="https://a.example/x?y=1&amp;z=2">https://a.example/x?y=1&amp;z=2</a>.</p>');
    expect(html.indexOf("Siehe")).toBeLessThan(html.indexOf("Artur Ferreira"));
    expect(html).toContain(SIGNATURE);
  });

  it("detects a body that already has the signature", () => {
    expect(bodyHasSignature("Hi\n\nArtur Ferreira\nGründer, Example", SIGNATURE)).toBe(true);
    expect(bodyHasSignature("see https://example.com/a.png", SIGNATURE)).toBe(true);
    expect(bodyHasSignature("Grüsse\nArtur Ferreira", SIGNATURE)).toBe(false);
  });

  it("prefers the reply default for replies and a signature that fits the sender", () => {
    const set = {
      signatures: [
        { id: 1, sender: "other@example.com", content: "<p>other</p>", is_default: true },
        { id: 2, sender: null, content: "<p>new</p>" },
        { id: 3, sender: null, content: "<p>reply</p>" },
      ],
      defaultId: "2",
      defaultReplyId: "3",
    };
    expect(pickSignature(set, "info@example.com", false)?.id).toBe(2);
    expect(pickSignature(set, "info@example.com", true)?.id).toBe(3);
    expect(pickSignature(set, "other@example.com", false)?.id).toBe(2);
    expect(pickSignature({ signatures: [], defaultId: null, defaultReplyId: null }, "a@b.c", false)).toBeNull();
  });

  it("creates a threaded HTML draft with the fetched signature", async () => {
    respondWith(signatureRoutes({
      [`GET ${API}/mail/uuid-1/folder/F1/message/42`]: () => ({ msg_id: "<m42@example.com>", headers: {} }),
    }));
    const result = await client().createDraft(undefined, { to: "me@example.com", subject: "Re: x", body: "Hallo", inReplyToUid: "42@F1" });
    const saved = JSON.parse(String(calls("POST")[0][1].body));
    expect(saved).toMatchObject({ mime_type: "text/html", in_reply_to: "<m42@example.com>" });
    expect(saved.body).toContain(SIGNATURE);
    expect(result.signature).toMatchObject({ applied: true, id: "3", name: "Standard" });
  });

  it("leaves the body alone with signature: false or when it already has the signature", async () => {
    respondWith(signatureRoutes());
    const c = client();
    await c.createDraft(undefined, { to: "me@example.com", subject: "s", body: "Hallo", signature: false });
    await c.createDraft(undefined, { to: "me@example.com", subject: "s", body: "Hallo\nArtur Ferreira\nGründer, Example" });
    const [off, dup] = calls("POST").map(([, init]) => JSON.parse(String(init.body)).body as string);
    expect(off).not.toContain("<table");
    expect(dup).not.toContain("<table");
  });

  it("refuses to save an unsigned draft when the signature cannot be loaded", async () => {
    respondWith({ [`GET ${API}/mailbox`]: mailboxes });
    await expect(client().createDraft(undefined, { to: "me@example.com", subject: "s", body: "x" })).rejects.toThrow(/signature/);
    expect(calls("POST")).toHaveLength(0);
  });

  it("adds the signature when a draft body is replaced, and only then", async () => {
    respondWith(signatureRoutes());
    const c = client();
    await c.createDraft(undefined, { to: "me@example.com", subject: "s", body: "v1", signature: false });
    const changed = await c.updateDraft("uuid-1", "d-1", { body: "v2" });
    expect(JSON.parse(String(calls("PUT")[0][1].body)).body).toContain(SIGNATURE);
    expect(changed.signature).toMatchObject({ applied: true });
    const before = JSON.parse(String(calls("PUT")[0][1].body)).body;
    await c.updateDraft("uuid-1", "d-1", { subject: "s2" });
    expect(JSON.parse(String(calls("PUT")[1][1].body)).body).toBe(before);
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
