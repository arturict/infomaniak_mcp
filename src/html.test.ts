import { describe, it, expect } from "vitest";
import { htmlToText, sanitiseHtml } from "./html.js";

describe("htmlToText", () => {
  it("drops styles and scripts and keeps readable paragraphs", () => {
    const html = `<html><head><style>p{color:red}</style></head><body>
      <p>Grüezi&nbsp;Frau M&uuml;ller,</p><script>track()</script>
      <div>Offerte im Anhang.<br>Danke &amp; Gruss</div></body></html>`;
    expect(htmlToText(html)).toBe("Grüezi Frau Müller,\n\nOfferte im Anhang.\nDanke & Gruss");
  });

  it("keeps link targets that differ from the label", () => {
    expect(htmlToText('<a href="https://example.com/x">Portal</a>')).toBe("Portal (https://example.com/x)");
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe("https://example.com");
  });

  it("turns list items into dashes", () => {
    expect(htmlToText("<ul><li>One</li><li>Two</li></ul>")).toBe("- One\n- Two");
  });
});

describe("sanitiseHtml", () => {
  it("removes scripts, inline styles and event handlers", () => {
    expect(sanitiseHtml('<p style="x" onclick="y()">Hi</p><script>z()</script>')).toBe("<p>Hi</p>");
  });
});
