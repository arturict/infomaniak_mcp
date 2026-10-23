/**
 * Small HTML helpers for e-mail bodies.
 *
 * Mail HTML is often hundreds of kilobytes of tables, inline styles and
 * tracking markup around a few sentences. Converting it to text keeps tool
 * results readable and small. This is a pragmatic converter, not a parser:
 * it only has to produce readable text, never safe HTML for a browser.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  shy: "",
  zwnj: "",
  zwj: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  euro: "€",
  copy: "©",
  reg: "®",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  Eacute: "É",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Remove elements whose content is never meant to be read. */
function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, "");
}

/**
 * Convert HTML to readable plain text: block elements become line breaks,
 * links keep their target when it differs from the text, entities are
 * decoded and runs of blank lines collapse.
 */
export function htmlToText(html: string): string {
  let text = stripInvisible(html);
  text = text.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, "").trim();
    const target = decodeEntities(href.trim());
    if (!label) return target.startsWith("mailto:") ? target.slice(7) : "";
    if (!/^(https?:|mailto:)/i.test(target) || decodeEntities(label) === target || target === `mailto:${decodeEntities(label)}`) {
      return label;
    }
    return `${label} (${target})`;
  });
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|table|blockquote|pre|section|article|header|footer|ul|ol)\s*>/gi, "\n")
    .replace(/<(p|div|h[1-6]|tr|table|blockquote|pre|section|article|header|footer|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Reduce HTML for a model that asked for markup: drop scripts, styles,
 * comments and inline style/event attributes, which carry no content.
 */
export function sanitiseHtml(html: string): string {
  return stripInvisible(html)
    .replace(/\s(style|on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
