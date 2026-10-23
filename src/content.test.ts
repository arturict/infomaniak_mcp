import { describe, it, expect } from "vitest";
import { binaryToContent, decodeBase64, isTextLike, textFileToContent } from "./content.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("isTextLike", () => {
  it("treats text MIME types and known text extensions as text", () => {
    expect(isTextLike("text/csv; charset=utf-8", "a.csv")).toBe(true);
    expect(isTextLike("application/json", "data")).toBe(true);
    expect(isTextLike("application/octet-stream", "notes.md")).toBe(true);
  });

  it("treats documents and images as binary", () => {
    expect(isTextLike("application/pdf", "offer.pdf")).toBe(false);
    expect(isTextLike("image/png", "logo.png")).toBe(false);
    expect(isTextLike("application/octet-stream", "archive.zip")).toBe(false);
  });
});

describe("binaryToContent", () => {
  it("returns web images as image blocks", () => {
    const [meta, block] = binaryToContent({ filename: "a.PNG", mimeType: "IMAGE/PNG", bytes: bytes("x") }, "u://1");
    expect(block).toEqual({ type: "image", data: "eA==", mimeType: "image/png" });
    expect(meta.type).toBe("text");
  });

  it("returns other binaries as embedded resources", () => {
    const [, block] = binaryToContent({ filename: "a.pdf", mimeType: "application/pdf", bytes: bytes("x") }, "u://1");
    expect(block).toEqual({ type: "resource", resource: { uri: "u://1", mimeType: "application/pdf", blob: "eA==" } });
  });
});

describe("textFileToContent", () => {
  it("truncates long text and says so in the metadata", () => {
    const [meta, body] = textFileToContent({ filename: "a.txt", mimeType: "text/plain", bytes: bytes("abcdef") }, 3);
    expect(body).toEqual({ type: "text", text: "abc" });
    expect(meta.type === "text" && JSON.parse(meta.text)).toMatchObject({ truncated: true, total_chars: 6 });
  });
});

describe("decodeBase64", () => {
  it("decodes valid base64 and rejects garbage", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8="))).toBe("hello");
    expect(() => decodeBase64("not base64!")).toThrow(/not valid base64/);
  });
});
