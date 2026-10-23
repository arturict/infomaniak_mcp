/**
 * MCP tools for reading and drafting e-mail through the Infomaniak Mail API.
 *
 * These are user-side tools (the token owner's own mailboxes). The
 * `infomaniak_*mailbox*` tools in server.ts manage mailboxes as an admin and
 * cannot read messages.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MailClient, type DraftAttachmentInput } from "./mail-client.js";
import {
  ToolContent,
  MAX_BINARY_BYTES,
  binaryToContent,
  decodeBase64,
  mimeTypeFromFilename,
} from "./content.js";
import {
  validate,
  MailMailboxSchema,
  MailListEmailsSchema,
  MailSearchEmailsSchema,
  MailReadEmailSchema,
  MailDownloadAttachmentSchema,
  MailCreateDraftSchema,
  MailUpdateDraftSchema,
  MailDraftIdSchema,
  MailSendDraftSchema,
  MailMoveEmailsSchema,
  MailMarkSeenSchema,
  MailFlagSchema,
} from "./schemas.js";

const mailbox = {
  type: "string",
  description: "Mailbox email address or UUID (default: INFOMANIAK_MAIL_MAILBOX, else the first mailbox)",
};
const folder = {
  type: "string",
  description: "Folder id, role (INBOX, SENT, DRAFT, TRASH, ARCHIVE, SPAM) or path",
};
const messageIds = {
  type: "array",
  items: { type: "string" },
  description: "Message UIDs from list/search results (the `uid` of a message)",
};
const attachments = {
  type: "array",
  description: "Files to attach (max 10, 10 MB in total)",
  items: {
    type: "object",
    properties: {
      filename: { type: "string" },
      content_base64: { type: "string", description: "Base64-encoded file content" },
      mime_type: { type: "string", description: "Optional; guessed from the file name" },
    },
    required: ["filename", "content_base64"],
  },
};

export const mailTools: Tool[] = [
  {
    name: "infomaniak_mail_list_mailboxes",
    description: "List the mailboxes the token can read (email address and UUID).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "infomaniak_mail_list_folders",
    description: "List the folders of a mailbox with id, path, role and unread/total counts.",
    inputSchema: { type: "object", properties: { mailbox }, required: [] },
  },
  {
    name: "infomaniak_mail_list_emails",
    description: "List e-mail threads in a folder (default INBOX), newest first. Each thread lists its messages with uid and folder_id for infomaniak_mail_read_email.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        folder: { ...folder, description: `${folder.description}; default INBOX` },
        limit: { type: "number", description: "Max threads (1-100, default 20)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
        unseen: { type: "boolean", description: "Only unread threads (cannot be combined with flagged)" },
        flagged: { type: "boolean", description: "Only flagged threads (cannot be combined with unseen)" },
      },
      required: [],
    },
  },
  {
    name: "infomaniak_mail_search_emails",
    description: "Search e-mails by text, sender, recipient, subject or date range. Searches all folders unless a folder is given.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        query: { type: "string", description: "Text contained in the message" },
        from: { type: "string", description: "Sender address or name" },
        to: { type: "string", description: "Recipient address or name" },
        subject: { type: "string", description: "Text in the subject" },
        since: { type: "string", description: "On or after this date (YYYY-MM-DD)" },
        before: { type: "string", description: "Before this date (YYYY-MM-DD)" },
        folder: { ...folder, description: `${folder.description}; omit to search every folder` },
        limit: { type: "number", description: "Max results (1-100, default 20)" },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
      required: [],
    },
  },
  {
    name: "infomaniak_mail_read_email",
    description: "Read one e-mail. Returns the body as plain text (HTML converted and truncated to max_chars) plus attachment metadata and a reply_to_uid for drafting a reply.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        folder: { ...folder, description: "Folder of the message (folder_id from list/search results)" },
        message_id: { type: "string", description: "Message uid from list/search results" },
        format: { type: "string", enum: ["text", "html"], description: "Body format: text (default) or html with scripts and styles removed" },
        max_chars: { type: "number", description: "Truncate the body to this many characters (default 20000)" },
      },
      required: ["folder", "message_id"],
    },
  },
  {
    name: "infomaniak_mail_download_attachment",
    description: "Download an e-mail attachment (max 10 MB). Web images come back as image content, other files as an embedded resource.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        folder: { ...folder, description: "Folder of the message" },
        message_id: { type: "string", description: "Message uid" },
        attachment_id: { type: "string", description: "Attachment id from infomaniak_mail_read_email" },
      },
      required: ["folder", "message_id", "attachment_id"],
    },
  },
  {
    name: "infomaniak_mail_create_draft",
    description: "Create an e-mail draft in the mailbox. Nothing is sent. To reply, pass reply_to_uid from infomaniak_mail_read_email as in_reply_to_uid so the draft is threaded.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        to: { type: "string", description: "Recipient address(es), comma-separated" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body" },
        cc: { type: "string", description: "CC address(es), comma-separated" },
        bcc: { type: "string", description: "BCC address(es), comma-separated" },
        in_reply_to_uid: { type: "string", description: "Message being replied to, as UID@folder_id (reply_to_uid from read_email)" },
        in_reply_to: { type: "string", description: "Message-ID being replied to (resolved from in_reply_to_uid when omitted)" },
        references: { type: "string", description: "References header (resolved from in_reply_to_uid when omitted)" },
        from_email: { type: "string", description: "Sender: the mailbox address or one of its aliases" },
        from_name: { type: "string", description: "Preferred display name; the name of the matching kMail identity wins" },
        attachments,
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "infomaniak_mail_update_draft",
    description: "Change a draft created with infomaniak_mail_create_draft. Only the given fields change; attachments are added.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        draft_uuid: { type: "string" },
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body (replaces the current body)" },
        cc: { type: "string" },
        bcc: { type: "string" },
        attachments,
      },
      required: ["draft_uuid"],
    },
  },
  {
    name: "infomaniak_mail_delete_draft",
    description: "Delete a draft.",
    inputSchema: { type: "object", properties: { mailbox, draft_uuid: { type: "string" } }, required: ["draft_uuid"] },
  },
  {
    name: "infomaniak_mail_send_draft",
    description: "Send an existing draft. Only available when the server sets INFOMANIAK_ENABLE_MAIL_SEND=true.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        draft_uuid: { type: "string" },
        delay_seconds: { type: "number", description: "Schedule sending this many seconds from now (default 0)" },
      },
      required: ["draft_uuid"],
    },
  },
  {
    name: "infomaniak_mail_move_emails",
    description: "Move messages to another folder, for example to ARCHIVE or TRASH.",
    inputSchema: {
      type: "object",
      properties: {
        mailbox,
        folder: { ...folder, description: "Current folder of the messages" },
        message_ids: messageIds,
        destination_folder: { ...folder, description: "Target folder id, role or path" },
      },
      required: ["folder", "message_ids", "destination_folder"],
    },
  },
  {
    name: "infomaniak_mail_mark_seen",
    description: "Mark messages as read (seen=true) or unread (seen=false).",
    inputSchema: {
      type: "object",
      properties: { mailbox, folder, message_ids: messageIds, seen: { type: "boolean" } },
      required: ["folder", "message_ids", "seen"],
    },
  },
  {
    name: "infomaniak_mail_flag",
    description: "Flag (flagged=true) or unflag (flagged=false) messages.",
    inputSchema: {
      type: "object",
      properties: { mailbox, folder, message_ids: messageIds, flagged: { type: "boolean" } },
      required: ["folder", "message_ids", "flagged"],
    },
  },
];

function decodeAttachments(input: { filename: string; content_base64: string; mime_type?: string }[] | undefined): DraftAttachmentInput[] | undefined {
  if (!input?.length) return undefined;
  const decoded = input.map((a) => ({
    filename: a.filename,
    mimeType: a.mime_type ?? mimeTypeFromFilename(a.filename),
    content: decodeBase64(a.content_base64),
  }));
  const total = decoded.reduce((sum, a) => sum + a.content.byteLength, 0);
  if (total > MAX_BINARY_BYTES) {
    throw new Error(`Attachments total ${total} bytes; the limit is ${MAX_BINARY_BYTES} bytes`);
  }
  return decoded;
}

export async function handleMailToolCall(
  mail: MailClient,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<unknown> {
  switch (name) {
    case "infomaniak_mail_list_mailboxes":
      return mail.listMailboxes();

    case "infomaniak_mail_list_folders": {
      const v = validate(MailMailboxSchema, args ?? {});
      const mb = await mail.resolveMailbox(v.mailbox);
      return { mailbox: mb.email, folders: await mail.listFolders(mb.uuid) };
    }

    case "infomaniak_mail_list_emails": {
      const v = validate(MailListEmailsSchema, args ?? {});
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = await mail.resolveFolderId(mb.uuid, v.folder);
      const threads = await mail.listEmails(mb.uuid, folderId, v);
      return { mailbox: mb.email, folder_id: folderId, threads };
    }

    case "infomaniak_mail_search_emails": {
      const v = validate(MailSearchEmailsSchema, args ?? {});
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = v.folder ? await mail.resolveFolderId(mb.uuid, v.folder) : undefined;
      const threads = await mail.searchEmails(mb.uuid, { ...v, folderId });
      return { mailbox: mb.email, threads };
    }

    case "infomaniak_mail_read_email": {
      const v = validate(MailReadEmailSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = await mail.resolveFolderId(mb.uuid, v.folder);
      return mail.readEmail(mb.uuid, folderId, v.message_id, { format: v.format, maxChars: v.max_chars });
    }

    case "infomaniak_mail_download_attachment": {
      const v = validate(MailDownloadAttachmentSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = await mail.resolveFolderId(mb.uuid, v.folder);
      const file = await mail.downloadAttachment(mb.uuid, folderId, v.message_id, v.attachment_id, MAX_BINARY_BYTES);
      const uri = `infomaniak-mail://${mb.uuid}/${encodeURIComponent(folderId)}/${encodeURIComponent(v.message_id)}/${encodeURIComponent(v.attachment_id)}`;
      return new ToolContent(binaryToContent(file, uri));
    }

    case "infomaniak_mail_create_draft": {
      const v = validate(MailCreateDraftSchema, args);
      return mail.createDraft(v.mailbox, {
        to: v.to,
        subject: v.subject,
        body: v.body,
        cc: v.cc,
        bcc: v.bcc,
        inReplyTo: v.in_reply_to,
        inReplyToUid: v.in_reply_to_uid,
        references: v.references,
        fromEmail: v.from_email,
        fromName: v.from_name,
        attachments: decodeAttachments(v.attachments),
      });
    }

    case "infomaniak_mail_update_draft": {
      const v = validate(MailUpdateDraftSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      return mail.updateDraft(mb.uuid, v.draft_uuid, {
        to: v.to,
        subject: v.subject,
        body: v.body,
        cc: v.cc,
        bcc: v.bcc,
        attachments: decodeAttachments(v.attachments),
      });
    }

    case "infomaniak_mail_delete_draft": {
      const v = validate(MailDraftIdSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      return mail.deleteDraft(mb.uuid, v.draft_uuid);
    }

    case "infomaniak_mail_send_draft": {
      const v = validate(MailSendDraftSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      return mail.sendDraft(mb.uuid, v.draft_uuid, v.delay_seconds);
    }

    case "infomaniak_mail_move_emails": {
      const v = validate(MailMoveEmailsSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      const from = await mail.resolveFolderId(mb.uuid, v.folder);
      const to = await mail.resolveFolderId(mb.uuid, v.destination_folder);
      return mail.moveEmails(mb.uuid, v.message_ids, from, to);
    }

    case "infomaniak_mail_mark_seen": {
      const v = validate(MailMarkSeenSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = await mail.resolveFolderId(mb.uuid, v.folder);
      return mail.markEmails(mb.uuid, folderId, v.message_ids, v.seen);
    }

    case "infomaniak_mail_flag": {
      const v = validate(MailFlagSchema, args);
      const mb = await mail.resolveMailbox(v.mailbox);
      const folderId = await mail.resolveFolderId(mb.uuid, v.folder);
      return mail.flagEmails(mb.uuid, folderId, v.message_ids, v.flagged);
    }

    default:
      throw new Error(`Unknown mail tool: ${name}`);
  }
}
