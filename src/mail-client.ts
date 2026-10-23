/**
 * Infomaniak Mail client (user-side mail API at https://mail.infomaniak.com/api).
 *
 * Ported from Infomaniak's official MCP mail server
 * (https://github.com/Infomaniak/mcp-server-mail, src/mail-client.ts at
 * commit 12ed9ca), which is published under the MIT License:
 *
 *   Copyright (c) Infomaniak
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the "Software"),
 *   to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense,
 *   and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 *   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 *
 * Changes from the original: responses are narrowed from `unknown` instead of
 * typed `any`; the mailbox can be chosen by email address or UUID; message
 * bodies are returned as plain text by default and truncated; attachments for
 * drafts are passed as base64 content, never as local file paths; folder
 * creation/deletion and permanent message deletion are not ported.
 *
 * The token needs the `workspace:mail` scope.
 */

import { htmlToText, sanitiseHtml } from "./html.js";
import { normaliseMimeType, truncateText } from "./content.js";

const DEFAULT_MAIL_API_BASE = "https://mail.infomaniak.com/api";
const DEFAULT_MANAGER_API_BASE = "https://api.infomaniak.com/1";
const REQUEST_TIMEOUT_MS = 30_000;
const FOLDER_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHED_DRAFTS = 200;

// ---------------------------------------------------------------------------
// Narrowing helpers for untyped API responses
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Recipient {
  name: string;
  email: string;
}

export interface MailboxInfo {
  uuid: string;
  email: string;
  mailbox: string;
  is_primary: boolean;
  hosting_id: number | null;
  aliases: string[];
}

export interface MailFolder {
  id: string;
  name: string;
  path: string;
  role: string | null;
  unread_count: number | null;
  total_count: number | null;
}

export interface ThreadMessageSummary {
  uid: string;
  folder_id: string | null;
  date: string | null;
  from: string;
  seen: boolean | null;
}

export interface ThreadSummary {
  thread_uid: string | null;
  subject: string;
  from: string;
  to: string;
  date: string | null;
  messages_count: number | null;
  unseen_messages: number | null;
  seen: boolean;
  flagged: boolean;
  preview: string;
  /** Messages in the thread; `uid` + `folder_id` identify a message for read_email. */
  messages: ThreadMessageSummary[];
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
}

export interface EmailBodyOptions {
  format: "text" | "html";
  maxChars: number;
}

export interface DraftAttachmentInput {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  inReplyToUid?: string;
  references?: string;
  fromEmail?: string;
  fromName?: string;
  attachments?: DraftAttachmentInput[];
}

export interface DraftChanges {
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
  attachments?: DraftAttachmentInput[];
}

/** The draft fields the API accepts on save; mirrors the official payload. */
interface DraftPayload {
  uuid: string | null;
  subject: string;
  body: string;
  quote: null;
  mime_type: string;
  from: { id: null; name: string; email: string };
  reply_to: Recipient;
  to: Recipient[] | null;
  cc: Recipient[] | null;
  bcc: Recipient[] | null;
  references: string;
  in_reply_to: string | null;
  in_reply_to_uid: string | null;
  forwarded_uid: null;
  attachments: string[];
  identity_id: string | null;
  ack_request: boolean;
  st_uuid: null;
  uid: string | null;
  resource: string | null;
  priority: string;
  encrypted: boolean;
  encryption_password: string;
  event_poll_uuid: null;
  action: "save" | "send";
  delay: number;
}

export interface MailClientOptions {
  /** Mailbox used when a tool call names none: email address or UUID. */
  defaultMailbox?: string;
  mailApiBase?: string;
  managerApiBase?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatAddresses(value: unknown): string {
  return records(value)
    .map((r) => {
      const email = str(r.email) ?? "";
      const name = str(r.name) ?? "";
      return name ? `${name} <${email}>` : email;
    })
    .join(", ");
}

export function parseRecipients(recipientString?: string): Recipient[] | null {
  if (!recipientString) return null;
  const recipients = recipientString
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ name: "", email }));
  return recipients.length > 0 ? recipients : null;
}

function escapeHtml(text: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  };
  return text.replace(/[&<>"']/g, (char) => replacements[char]);
}

export function createHtmlBody(body: string): string {
  const escapedBody = escapeHtml(body).replace(/\n/g, "<br>");
  return `<html><body><div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px;">${escapedBody}</div></body></html>`;
}

function parseFilename(contentDisposition: string, fallback: string): string {
  const starMatch = contentDisposition.match(/filename\*=([^;]+)/);
  if (starMatch) {
    const raw = starMatch[1].trim();
    const encodingMatch = raw.match(/([^']*)'([^']*)'(.+)/);
    try {
      return decodeURIComponent(encodingMatch ? encodingMatch[3] : raw);
    } catch {
      return raw;
    }
  }
  const match = contentDisposition.match(/filename="?([^";]+)"?/);
  return match ? match[1].trim() : fallback;
}

/** Messages are addressed as `UID@folder_id`; bare UIDs get the folder appended. */
function formatUids(messageIds: string[], folderId: string): string[] {
  return messageIds.map((id) => (id.includes("@") ? id : `${id}@${folderId}`));
}

function messageSummary(message: JsonRecord): ThreadMessageSummary {
  const rawUid = str(message.uid) ?? "";
  return {
    uid: rawUid.split("@")[0],
    folder_id: str(message.folder_id) ?? null,
    date: str(message.date) ?? null,
    from: formatAddresses(message.from),
    seen: bool(message.seen) ?? null,
  };
}

function threadSummary(thread: JsonRecord): ThreadSummary {
  const messages = records(thread.messages);
  const unseen = num(thread.unseen_messages) ?? null;
  return {
    thread_uid: str(thread.uid) ?? null,
    subject: str(thread.subject) || "(no subject)",
    from: formatAddresses(thread.from),
    to: formatAddresses(thread.to),
    date: str(thread.date) ?? null,
    messages_count: num(thread.messages_count) ?? null,
    unseen_messages: unseen,
    seen: (unseen ?? 0) === 0,
    flagged: bool(thread.flagged) ?? messages.some((m) => m.flagged === true),
    preview: str(messages[0]?.preview) ?? "",
    messages: messages.map(messageSummary),
  };
}

/**
 * The message body arrives either as a string or as `{ type, value, subBody }`.
 * Returns the main part and its MIME type.
 */
function extractBody(body: unknown): { type: string; value: string } | null {
  if (typeof body === "string") return { type: "text/html", value: body };
  if (isRecord(body) && typeof body.value === "string") {
    return { type: normaliseMimeType(str(body.type) ?? "text/html"), value: body.value };
  }
  return null;
}

/** Narrow a draft fetched from the API into the save payload, or fail. */
function narrowRecipients(value: unknown): Recipient[] | null | undefined {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return undefined;
  const out: Recipient[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.email !== "string") return undefined;
    out.push({ name: str(item.name) ?? "", email: item.email });
  }
  return out;
}

export function draftPayloadFromApi(data: unknown, draftUuid: string): DraftPayload | null {
  if (!isRecord(data)) return null;
  const body = typeof data.body === "string" ? data.body : extractBody(data.body)?.value;
  const subject = data.subject === null ? "" : str(data.subject);
  const to = narrowRecipients(data.to);
  const cc = narrowRecipients(data.cc);
  const bcc = narrowRecipients(data.bcc);
  const fromList = narrowRecipients(Array.isArray(data.from) ? data.from : data.from ? [data.from] : null);
  const from = fromList?.[0];
  if (body === undefined || subject === undefined || to === undefined || cc === undefined || bcc === undefined || !from) {
    return null;
  }
  const attachments: string[] = [];
  for (const att of Array.isArray(data.attachments) ? data.attachments : []) {
    if (typeof att === "string") attachments.push(att);
    else if (isRecord(att) && typeof att.uuid === "string") attachments.push(att.uuid);
    else return null;
  }
  return {
    uuid: draftUuid,
    subject,
    body,
    quote: null,
    mime_type: str(data.mime_type) ?? "text/html",
    from: { id: null, name: from.name, email: from.email },
    reply_to: narrowRecipients(Array.isArray(data.reply_to) ? data.reply_to : data.reply_to ? [data.reply_to] : null)?.[0] ?? from,
    to,
    cc,
    bcc,
    references: str(data.references) ?? "",
    in_reply_to: str(data.in_reply_to) ?? null,
    in_reply_to_uid: str(data.in_reply_to_uid) ?? null,
    forwarded_uid: null,
    attachments,
    identity_id: data.identity_id === null || data.identity_id === undefined ? null : String(data.identity_id),
    ack_request: bool(data.ack_request) ?? false,
    st_uuid: null,
    uid: str(data.uid) ?? null,
    resource: null,
    priority: str(data.priority) ?? "normal",
    encrypted: false,
    encryption_password: "",
    event_poll_uuid: null,
    action: "save",
    delay: 0,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MailClient {
  private readonly token: string;
  private readonly mailApiBase: string;
  private readonly managerApiBase: string;
  private readonly defaultMailbox: string | undefined;
  private mailboxes: MailboxInfo[] | null = null;
  private readonly folderCache = new Map<string, { at: number; folders: MailFolder[] }>();
  private readonly identitiesCache = new Map<string, JsonRecord[]>();
  /**
   * Draft payloads saved in this process, keyed by draft UUID. The API needs
   * the full payload on every save, so updates start from this copy. The
   * client is created once per process so the cache survives HTTP sessions.
   */
  private readonly draftsCache = new Map<string, DraftPayload>();

  constructor(token: string, options: MailClientOptions = {}) {
    this.token = token;
    this.mailApiBase = options.mailApiBase ?? DEFAULT_MAIL_API_BASE;
    this.managerApiBase = options.managerApiBase ?? DEFAULT_MANAGER_API_BASE;
    this.defaultMailbox = options.defaultMailbox?.trim() || undefined;
  }

  private async fetchOk(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Mail API request failed: ${response.status} ${response.statusText}\n${text.slice(0, 500)}`);
    }
    return response;
  }

  /** JSON request against the mail API; returns `data` of a successful envelope. */
  private async apiRequest(path: string, init: RequestInit = {}, base = this.mailApiBase): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
    const response = await this.fetchOk(`${base}${path}`, { ...init, headers });
    const json: unknown = await response.json();
    if (!isRecord(json) || json.result !== "success") {
      throw new Error(`Mail API returned an error: ${JSON.stringify(json).slice(0, 500)}`);
    }
    return json.data;
  }

  // ---- Mailboxes and folders ---------------------------------------------

  async listMailboxes(): Promise<MailboxInfo[]> {
    if (!this.mailboxes) {
      const data = await this.apiRequest("/mailbox?with=aliases,permissions,accountId,count_users");
      this.mailboxes = records(data).map((m) => ({
        uuid: str(m.uuid) ?? "",
        email: str(m.email) ?? "",
        mailbox: str(m.mailbox) ?? "",
        is_primary: bool(m.is_primary) ?? false,
        hosting_id: num(m.hosting_id) ?? null,
        aliases: strings(m.aliases),
      })).filter((m) => m.uuid);
    }
    return this.mailboxes;
  }

  /**
   * Pick a mailbox by email address or UUID; without a selector, use the
   * configured default or else the first mailbox the token can see.
   */
  async resolveMailbox(selector?: string): Promise<MailboxInfo> {
    const mailboxes = await this.listMailboxes();
    if (mailboxes.length === 0) {
      throw new Error("No mailboxes found. Check that the token has the workspace:mail scope.");
    }
    const wanted = (selector?.trim() || this.defaultMailbox)?.toLowerCase();
    if (!wanted) return mailboxes[0];
    const match = mailboxes.find((m) => m.uuid.toLowerCase() === wanted || m.email.toLowerCase() === wanted);
    if (!match) {
      throw new Error(`Mailbox ${wanted} not found. Available: ${mailboxes.map((m) => m.email).join(", ")}`);
    }
    return match;
  }

  async listFolders(mailboxUuid: string): Promise<MailFolder[]> {
    const cached = this.folderCache.get(mailboxUuid);
    if (cached && Date.now() - cached.at < FOLDER_CACHE_TTL_MS) return cached.folders;

    const data = await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/folder?with=ik-static`);
    const flatten = (folders: JsonRecord[], prefix = ""): MailFolder[] => {
      const result: MailFolder[] = [];
      for (const folder of folders) {
        const name = str(folder.name) ?? "";
        const fullPath = prefix ? `${prefix}${str(folder.separator) ?? "/"}${name}` : name;
        result.push({
          id: str(folder.id) ?? String(folder.id ?? ""),
          name,
          path: fullPath,
          role: str(folder.role) ?? null,
          unread_count: num(folder.unread_count) ?? null,
          total_count: num(folder.total_count) ?? null,
        });
        result.push(...flatten(records(folder.children), fullPath));
      }
      return result;
    };
    const folders = flatten(records(data));
    this.folderCache.set(mailboxUuid, { at: Date.now(), folders });
    return folders;
  }

  /**
   * Accept a folder id, a role (INBOX, SENT, DRAFT, TRASH, ARCHIVE, SPAM) or a
   * folder path; without one, use the inbox.
   */
  async resolveFolderId(mailboxUuid: string, folder?: string): Promise<string> {
    const folders = await this.listFolders(mailboxUuid);
    const wanted = (folder?.trim() || "INBOX").toLowerCase();
    const match =
      folders.find((f) => f.id.toLowerCase() === wanted) ??
      folders.find((f) => f.role?.toLowerCase() === wanted) ??
      folders.find((f) => f.path.toLowerCase() === wanted);
    if (match) return match.id;
    if (!folder) throw new Error("INBOX folder not found");
    // Unknown to the cached list: pass it through as an id and let the API decide.
    return folder.trim();
  }

  // ---- Reading -------------------------------------------------------------

  async listEmails(
    mailboxUuid: string,
    folderId: string,
    options: { limit: number; offset: number; unseen?: boolean; flagged?: boolean },
  ): Promise<ThreadSummary[]> {
    if (options.unseen && options.flagged) {
      throw new Error("The mail API supports only one filter at a time; request unseen or flagged, not both.");
    }
    const params = new URLSearchParams({
      offset: String(options.offset),
      thread: "on",
      severywhere: "0",
      limit: String(options.limit),
    });
    const filter = options.unseen ? "unseen" : options.flagged ? "starred" : null;
    if (filter) params.set("filters", filter);
    const data = await this.apiRequest(
      `/mail/${encodeURIComponent(mailboxUuid)}/folder/${encodeURIComponent(folderId)}/message?${params}`,
    );
    return records(isRecord(data) ? data.threads : undefined).map(threadSummary);
  }

  async searchEmails(
    mailboxUuid: string,
    options: {
      query?: string;
      from?: string;
      to?: string;
      subject?: string;
      since?: string;
      before?: string;
      folderId?: string;
      limit: number;
      offset: number;
    },
  ): Promise<ThreadSummary[]> {
    const { query, from, to, subject, since, before } = options;
    if (!query && !from && !to && !subject && !since && !before) {
      throw new Error("At least one search filter (query, from, to, subject, since, or before) must be provided.");
    }
    // Without a folder, search every folder; the API still needs a base folder.
    const everywhere = !options.folderId;
    const folderId = options.folderId ?? (await this.resolveFolderId(mailboxUuid));

    const params = new URLSearchParams({
      offset: String(options.offset),
      thread: "off",
      severywhere: everywhere ? "1" : "0",
      limit: String(options.limit),
    });
    if (query) params.set("scontains", query);
    if (from) params.set("sfrom", from);
    if (to) params.set("sto", to);
    if (subject) params.set("ssubject", subject);
    if (since) params.set("sfromdate", `${since} 00:00:00`);
    if (before) params.set("stodate", `${before} 00:00:00`);

    const data = await this.apiRequest(
      `/mail/${encodeURIComponent(mailboxUuid)}/folder/${encodeURIComponent(folderId)}/message?${params}`,
    );
    return records(isRecord(data) ? data.threads : undefined).map(threadSummary);
  }

  private async fetchMessage(mailboxUuid: string, folderId: string, messageId: string): Promise<JsonRecord> {
    const data = await this.apiRequest(
      `/mail/${encodeURIComponent(mailboxUuid)}/folder/${encodeURIComponent(folderId)}/message/${encodeURIComponent(messageId)}?prefered_format=html&with=auto_uncrypt,thread_context`,
    );
    if (!isRecord(data)) throw new Error(`Message ${messageId} not found`);
    return data;
  }

  async readEmail(mailboxUuid: string, folderId: string, messageId: string, options: EmailBodyOptions) {
    const data = await this.fetchMessage(mailboxUuid, folderId, messageId);
    const body = extractBody(data.body);
    let content = "";
    if (body) {
      const isHtml = body.type.includes("html");
      if (options.format === "html") content = isHtml ? sanitiseHtml(body.value) : body.value;
      else content = isHtml ? htmlToText(body.value) : body.value;
    }
    const { text, truncated } = truncateText(content, options.maxChars);
    const uid = (str(data.uid) ?? messageId).split("@")[0];

    const attachments: AttachmentInfo[] = records(data.attachments).map((att) => {
      const resource = str(att.resource);
      return {
        id: resource ? resource.split("/").pop() ?? "" : String(att.part_id ?? ""),
        filename: str(att.name) ?? "attachment",
        mime_type: str(att.mime_type) ?? "application/octet-stream",
        size: num(att.size) ?? 0,
      };
    });

    return {
      uid,
      folder_id: folderId,
      /** Pass as `in_reply_to_uid` when drafting a reply. */
      reply_to_uid: `${uid}@${folderId}`,
      msg_id: str(data.msg_id) ?? null,
      subject: str(data.subject) || "(no subject)",
      from: formatAddresses(data.from),
      to: formatAddresses(data.to),
      cc: formatAddresses(data.cc),
      reply_to: formatAddresses(data.reply_to),
      date: str(data.date) ?? null,
      seen: bool(data.seen) ?? null,
      flagged: bool(data.flagged) ?? null,
      body_format: options.format,
      body: text,
      body_truncated: truncated,
      ...(truncated ? { body_total_chars: content.length } : {}),
      attachments,
    };
  }

  async downloadAttachment(
    mailboxUuid: string,
    folderId: string,
    messageId: string,
    attachmentId: string,
    maxBytes: number,
  ): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }> {
    const url = `${this.mailApiBase}/mail/${encodeURIComponent(mailboxUuid)}/folder/${encodeURIComponent(folderId)}/message/${encodeURIComponent(messageId)}/attachment/${encodeURIComponent(attachmentId)}`;
    const response = await this.fetchOk(url);
    const announced = Number(response.headers.get("content-length") ?? "0");
    if (announced > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Attachment too large (${announced} bytes, max ${maxBytes} bytes)`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Attachment too large (${bytes.byteLength} bytes, max ${maxBytes} bytes)`);
    }
    return {
      filename: parseFilename(response.headers.get("content-disposition") ?? "", attachmentId),
      mimeType: normaliseMimeType(response.headers.get("content-type")),
      bytes,
    };
  }

  // ---- Drafts --------------------------------------------------------------

  private async getIdentities(mailbox: MailboxInfo): Promise<JsonRecord[]> {
    const cached = this.identitiesCache.get(mailbox.uuid);
    if (cached) return cached;
    if (mailbox.hosting_id === null || !mailbox.mailbox) {
      throw new Error("Mailbox is missing hosting_id or mailbox name; cannot load identities");
    }
    const data = await this.apiRequest(
      `/mail_hostings/${mailbox.hosting_id}/mailboxes/${encodeURIComponent(mailbox.mailbox)}/signatures`,
      {},
      this.managerApiBase,
    );
    if (!isRecord(data) || !Array.isArray(data.signatures)) throw new Error("Unexpected signatures response");
    const signatures = records(data.signatures);
    this.identitiesCache.set(mailbox.uuid, signatures);
    return signatures;
  }

  private async resolveFrom(
    mailbox: MailboxInfo,
    fromEmailParam?: string,
    fromNameParam?: string,
  ): Promise<{ email: string; name: string; identityId: string | null; warnings: string[] }> {
    const warnings: string[] = [];
    const allowedEmails = [mailbox.email, ...mailbox.aliases].filter((e) => e.trim().length > 0);

    let fromEmail = mailbox.email;
    if (fromEmailParam) {
      const requested = fromEmailParam.trim().toLowerCase();
      const match = allowedEmails.find((e) => e.toLowerCase() === requested);
      if (!match) {
        throw new Error(
          `from_email "${fromEmailParam}" is not allowed: use the mailbox address or one of its aliases (${allowedEmails.join(", ")})`,
        );
      }
      fromEmail = match;
    }

    // The API builds the From header from the sending identity (identity_id):
    // - identity_id set  -> signature sender + signature full_name
    // - identity_id null -> default identity sender + account profile display name
    // The from.name payload field is ignored by the API.
    let identity: JsonRecord | null = null;
    try {
      const identities = await this.getIdentities(mailbox);
      const candidates = identities.filter((s) => str(s.sender)?.toLowerCase() === fromEmail.toLowerCase());
      if (fromNameParam) {
        const requested = fromNameParam.trim().toLowerCase();
        identity = candidates.find((s) => str(s.full_name)?.trim().toLowerCase() === requested) ?? null;
        if (!identity) {
          warnings.push(
            `No identity named "${fromNameParam}" for ${fromEmail}: the display name comes from the matching identity or the account profile, not from from_name`,
          );
        }
      }
      if (!identity) {
        // A signature with an empty full_name would produce an anonymous From header
        const named = candidates.filter((s) => (str(s.full_name)?.trim().length ?? 0) > 0);
        identity = named.find((s) => s.is_default === true) ?? named[0] ?? null;
      }
      if (fromEmailParam && !identity && fromEmail.toLowerCase() !== mailbox.email.toLowerCase()) {
        warnings.push(
          `No sending identity exists for ${fromEmail}: the API will send from the default identity address instead. Create an identity for this alias in kMail to use it`,
        );
      }
    } catch {
      // Identities are optional: on failure the API falls back to the account profile display name
    }

    const identityName = identity ? str(identity.full_name) : undefined;
    return {
      email: fromEmail,
      name: identityName || fromNameParam || fromEmail.split("@")[0],
      identityId: identity && identity.id !== undefined ? String(identity.id) : null,
      warnings,
    };
  }

  private async resolveThreadingHeaders(
    mailboxUuid: string,
    inReplyToUid: string,
  ): Promise<{ inReplyTo: string; references: string }> {
    const atIndex = inReplyToUid.lastIndexOf("@");
    if (atIndex === -1) {
      throw new Error(`Invalid in_reply_to_uid format: ${inReplyToUid}. Expected format: 'UID@folder_id'`);
    }
    const uid = inReplyToUid.substring(0, atIndex);
    const folderId = inReplyToUid.substring(atIndex + 1);
    const source = await this.fetchMessage(mailboxUuid, folderId, uid);

    const sourceMsgId = str(source.msg_id);
    if (!sourceMsgId) {
      throw new Error(`Source message ${inReplyToUid} has no msg_id; cannot build threading headers`);
    }
    const headers = isRecord(source.headers) ? source.headers : {};
    const sourceRefs = str(headers.references) ?? str(headers.References) ?? "";
    const refParts = sourceRefs.split(/\s+/).filter((r) => r.length > 0);
    if (!refParts.includes(sourceMsgId)) refParts.push(sourceMsgId);
    return { inReplyTo: sourceMsgId, references: refParts.join(" ") };
  }

  private async uploadAttachment(mailboxUuid: string, attachment: DraftAttachmentInput): Promise<string> {
    // Header set as used by the official server; the API reads the raw body.
    const response = await this.fetchOk(`${this.mailApiBase}/mail/${encodeURIComponent(mailboxUuid)}/draft/attachment`, {
      method: "POST",
      body: new Uint8Array(attachment.content),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-ws-attachment-disposition": "attachment",
        "x-ws-attachment-filename": attachment.filename,
        "x-ws-attachment-mime-type": attachment.mimeType,
      },
    });
    const json: unknown = await response.json();
    const uuid = isRecord(json) && json.result === "success" && isRecord(json.data) ? str(json.data.uuid) : undefined;
    if (!uuid) throw new Error(`Failed to upload attachment: ${JSON.stringify(json).slice(0, 500)}`);
    return uuid;
  }

  private rememberDraft(draftUuid: string, payload: DraftPayload): void {
    this.draftsCache.delete(draftUuid);
    this.draftsCache.set(draftUuid, payload);
    while (this.draftsCache.size > MAX_CACHED_DRAFTS) {
      const oldest = this.draftsCache.keys().next().value;
      if (oldest === undefined) break;
      this.draftsCache.delete(oldest);
    }
  }

  /**
   * Draft state to build the next save from: the copy saved by this process,
   * or the draft fetched from the API when every needed field can be read.
   * A partially understood draft is never written back.
   */
  private async loadDraft(mailboxUuid: string, draftUuid: string): Promise<DraftPayload> {
    const cached = this.draftsCache.get(draftUuid);
    if (cached) return { ...cached };
    const data = await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/draft/${encodeURIComponent(draftUuid)}`);
    const payload = draftPayloadFromApi(data, draftUuid);
    if (!payload) {
      throw new Error(
        `Draft ${draftUuid} was not created by this server process and could not be read safely. Delete it and create a new draft instead.`,
      );
    }
    return payload;
  }

  async createDraft(mailboxSelector: string | undefined, input: DraftInput) {
    const mailbox = await this.resolveMailbox(mailboxSelector);

    let inReplyTo = input.inReplyTo ?? null;
    let references = input.references ?? "";
    if (input.inReplyToUid && (!input.inReplyTo || !input.references)) {
      const threading = await this.resolveThreadingHeaders(mailbox.uuid, input.inReplyToUid);
      if (!input.inReplyTo) inReplyTo = threading.inReplyTo;
      if (!input.references) references = threading.references;
    }

    const from = await this.resolveFrom(mailbox, input.fromEmail, input.fromName);
    const payload: DraftPayload = {
      uuid: null,
      subject: input.subject,
      body: createHtmlBody(input.body),
      quote: null,
      mime_type: "text/html",
      from: { id: null, name: from.name, email: from.email },
      reply_to: { name: from.name, email: from.email },
      to: parseRecipients(input.to),
      cc: parseRecipients(input.cc),
      bcc: parseRecipients(input.bcc),
      references,
      in_reply_to: inReplyTo,
      in_reply_to_uid: input.inReplyToUid ?? null,
      forwarded_uid: null,
      attachments: [],
      identity_id: from.identityId,
      ack_request: false,
      st_uuid: null,
      uid: null,
      resource: null,
      priority: "normal",
      encrypted: false,
      encryption_password: "",
      event_poll_uuid: null,
      action: "save",
      delay: 0,
    };

    const data = await this.apiRequest(`/mail/${encodeURIComponent(mailbox.uuid)}/draft`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const draftUuid = isRecord(data) ? str(data.uuid) : undefined;
    if (!draftUuid) throw new Error(`Failed to create draft: ${JSON.stringify(data).slice(0, 500)}`);
    payload.uuid = draftUuid;
    payload.uid = isRecord(data) ? str(data.uid) ?? null : null;
    this.rememberDraft(draftUuid, payload);

    // Attachments are added with a follow-up save, as in the official server.
    let attachmentCount = 0;
    if (input.attachments?.length) {
      const updated = await this.updateDraft(mailbox.uuid, draftUuid, { attachments: input.attachments });
      attachmentCount = updated.attachments;
    }

    return {
      mailbox: mailbox.email,
      draft_uuid: draftUuid,
      uid: payload.uid,
      subject: input.subject,
      to: input.to,
      cc: input.cc ?? null,
      bcc: input.bcc ?? null,
      in_reply_to: inReplyTo,
      attachments: attachmentCount,
      resolved_from: { email: from.email, name: from.name, identity_id: from.identityId },
      ...(from.warnings.length > 0 ? { warnings: from.warnings } : {}),
    };
  }

  async updateDraft(mailboxUuid: string, draftUuid: string, changes: DraftChanges) {
    const payload = await this.loadDraft(mailboxUuid, draftUuid);
    if (changes.to !== undefined) payload.to = parseRecipients(changes.to);
    if (changes.subject !== undefined) payload.subject = changes.subject;
    if (changes.body !== undefined) payload.body = createHtmlBody(changes.body);
    if (changes.cc !== undefined) payload.cc = parseRecipients(changes.cc);
    if (changes.bcc !== undefined) payload.bcc = parseRecipients(changes.bcc);
    if (changes.attachments?.length) {
      for (const attachment of changes.attachments) {
        payload.attachments.push(await this.uploadAttachment(mailboxUuid, attachment));
      }
    }
    payload.action = "save";
    payload.uuid = draftUuid;
    payload.resource = `/api/mail/${mailboxUuid}/draft/${draftUuid}`;

    const data = await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/draft/${encodeURIComponent(draftUuid)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    payload.uid = (isRecord(data) ? str(data.uid) : undefined) ?? payload.uid;
    this.rememberDraft(draftUuid, payload);

    return {
      draft_uuid: draftUuid,
      uid: payload.uid,
      subject: payload.subject,
      to: payload.to?.map((r) => r.email).join(", ") ?? "",
      cc: payload.cc?.map((r) => r.email).join(", ") ?? "",
      bcc: payload.bcc?.map((r) => r.email).join(", ") ?? "",
      attachments: payload.attachments.length,
    };
  }

  async sendDraft(mailboxUuid: string, draftUuid: string, delaySeconds: number): Promise<unknown> {
    const payload = await this.loadDraft(mailboxUuid, draftUuid);
    payload.action = "send";
    payload.delay = delaySeconds;
    payload.uuid = draftUuid;
    payload.resource = `/api/mail/${mailboxUuid}/draft/${draftUuid}`;
    const data = await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/draft/${encodeURIComponent(draftUuid)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    this.draftsCache.delete(draftUuid);
    return data;
  }

  async deleteDraft(mailboxUuid: string, draftUuid: string): Promise<{ deleted: string }> {
    await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/draft/${encodeURIComponent(draftUuid)}`, {
      method: "DELETE",
    });
    this.draftsCache.delete(draftUuid);
    return { deleted: draftUuid };
  }

  // ---- Message state -------------------------------------------------------

  async markEmails(mailboxUuid: string, folderId: string, messageIds: string[], seen: boolean) {
    const uids = formatUids(messageIds, folderId);
    await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/message/${seen ? "seen" : "unseen"}`, {
      method: "POST",
      body: JSON.stringify({ uids }),
    });
    return { result: "success", marked: uids.length, seen };
  }

  async flagEmails(mailboxUuid: string, folderId: string, messageIds: string[], flagged: boolean) {
    const uids = formatUids(messageIds, folderId);
    await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/message/${flagged ? "star" : "unstar"}`, {
      method: "POST",
      body: JSON.stringify({ uids }),
    });
    return { result: "success", flagged, count: uids.length };
  }

  async moveEmails(mailboxUuid: string, messageIds: string[], fromFolderId: string, toFolderId: string) {
    const uids = formatUids(messageIds, fromFolderId);
    await this.apiRequest(`/mail/${encodeURIComponent(mailboxUuid)}/message/move`, {
      method: "POST",
      body: JSON.stringify({ uids, to: toFolderId, move_reactions: false }),
    });
    return { result: "success", moved: uids.length, to: toFolderId };
  }
}
