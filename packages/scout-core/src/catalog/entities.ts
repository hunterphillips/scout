const NAMED: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

// The five XML names (case-sensitive, as XML requires) and bounded numeric references.
const ENTITY = /&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/g;

/** A numeric reference's character, or null when it is not a valid non-zero, non-surrogate code point. */
function numeric(entity: string): string | null {
  const hex = entity[2] === "x" || entity[2] === "X";
  const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return String.fromCodePoint(code);
}

/**
 * Decode XML's five predefined entities and numeric character references (`&#NNN;`,
 * `&#xHH;`) in one pass. Names are case-sensitive (`&AMP;` stays as written), numeric
 * references must name a valid non-zero, non-surrogate code point, and anything else,
 * including an invalid reference, is left as written. A single non-recursive pass cannot
 * expand (`&amp;lt;` becomes `&lt;`, not `<`). Used for sitemap text and HTML titles.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (entity) => (entity[1] === "#" ? (numeric(entity) ?? entity) : (NAMED[entity] ?? entity)));
}
