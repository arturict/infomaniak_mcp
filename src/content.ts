/**
 * Helpers that turn downloaded files and long text into MCP tool-result content.
 *
 * Shared by mail attachments and kDrive downloads so both cap sizes the same
 * way and return binaries as typed content blocks instead of base64 text.
 */

import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";

/** Largest binary returned inline as an image or embedded resource. */
export const MAX_BINARY_BYTES = 10 * 1024 * 1024;

/** Largest text file returned inline before it is truncated. */
export const MAX_TEXT_CHARS = 200_000;

/**
 * A tool result that is already a list of content blocks. The call handler
 * passes it through unchanged instead of serialising it as JSON text.
 */
export class ToolContent {
  constructor(readonly content: ContentBlock[]) {}
}

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

// Image formats MCP clients and LLM APIs commonly accept as image content.
// Others (TIFF, HEIC, SVG, BMP...) go out as a resource blob: an image block
// the client cannot decode can make it reject the whole tool result.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/x-sh",
  "application/sql",
  "application/ld+json",
  "image/svg+xml",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "html", "htm",
  "css", "js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "php",
  "sh", "sql", "ini", "toml", "conf", "cfg", "log", "env", "ics", "vcf", "svg", "tex",
]);

/** MIME types are case-insensitive (RFC 2045) and may carry parameters. */
export function normaliseMimeType(mimeType: string | null | undefined): string {
  const base = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return base || "application/octet-stream";
}

export function isTextLike(mimeType: string, filename: string): boolean {
  const mime = normaliseMimeType(mimeType);
  if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || mime.endsWith("+json") || mime.endsWith("+xml")) {
    return true;
  }
  if (mime !== "application/octet-stream") return false;
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * Turn a downloaded binary into content blocks: a small JSON metadata block
 * plus an `image` block for common web images or an embedded `resource` blob
 * for everything else. Clients cap text results and cannot read base64 text
 * as a document, so the binary must not travel inside a text block.
 */
export function binaryToContent(
  file: DownloadedFile,
  uri: string,
  metadata: Record<string, unknown> = {},
): ContentBlock[] {
  const mimeType = normaliseMimeType(file.mimeType);
  const data = Buffer.from(file.bytes).toString("base64");
  const meta = { ...metadata, filename: file.filename, mime_type: mimeType, size: file.bytes.byteLength };
  const binary: ContentBlock = INLINE_IMAGE_TYPES.has(mimeType)
    ? { type: "image", data, mimeType }
    : { type: "resource", resource: { uri, mimeType, blob: data } };
  return [{ type: "text", text: JSON.stringify(meta, null, 2) }, binary];
}

/**
 * Text files are returned as UTF-8 text so the model can read them directly,
 * truncated to `maxChars`.
 */
export function textFileToContent(
  file: DownloadedFile,
  maxChars: number,
  metadata: Record<string, unknown> = {},
): ContentBlock[] {
  const decoded = new TextDecoder("utf-8").decode(file.bytes);
  const { text, truncated } = truncateText(decoded, maxChars);
  const meta = {
    ...metadata,
    filename: file.filename,
    mime_type: normaliseMimeType(file.mimeType),
    size: file.bytes.byteLength,
    truncated,
    ...(truncated ? { returned_chars: maxChars, total_chars: decoded.length } : {}),
  };
  return [
    { type: "text", text: JSON.stringify(meta, null, 2) },
    { type: "text", text },
  ];
}

/** Decode a base64 string strictly enough to reject obvious garbage. */
export function decodeBase64(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 === 1) {
    throw new Error("content_base64 is not valid base64");
  }
  return new Uint8Array(Buffer.from(cleaned, "base64"));
}
