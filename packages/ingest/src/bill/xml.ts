/**
 * Minimal, dependency-free XML parser for the three trusted government feeds
 * this module consumes (GovInfo BILLSTATUS, House Clerk EVS rolls, Senate LIS
 * vote menu/detail). Supports the subset those documents use: declaration,
 * DOCTYPE, processing instructions, comments, CDATA, attributes, self-closing
 * tags, and the five predefined entities plus numeric character references.
 *
 * Deliberately not a general-purpose parser - it throws on malformed input
 * rather than recovering, which is the behavior we want for a daily cron
 * (fail loudly, keep last good data).
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

export class XmlParseError extends Error {
  constructor(message: string, position: number) {
    super(`${message} (at offset ${position})`);
    this.name = "XmlParseError";
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(parseInt(body.slice(1), 10));
    }
    return ENTITIES[body] ?? whole;
  });
}

/** Parse an XML document and return its root element. */
export function parseXml(input: string): XmlElement {
  let pos = 0;
  // Strip BOM.
  if (input.charCodeAt(0) === 0xfeff) pos = 1;

  function fail(message: string): never {
    throw new XmlParseError(message, pos);
  }

  function skipWhitespace(): void {
    while (pos < input.length && /\s/.test(input.charAt(pos))) pos++;
  }

  /** Skip <?...?>, <!--...-->, <!DOCTYPE...> (with optional internal subset). */
  function skipMisc(): void {
    for (;;) {
      skipWhitespace();
      if (input.startsWith("<?", pos)) {
        const end = input.indexOf("?>", pos);
        if (end === -1) fail("unterminated processing instruction");
        pos = end + 2;
      } else if (input.startsWith("<!--", pos)) {
        const end = input.indexOf("-->", pos);
        if (end === -1) fail("unterminated comment");
        pos = end + 3;
      } else if (input.startsWith("<!DOCTYPE", pos)) {
        let depth = 0;
        while (pos < input.length) {
          const ch = input.charAt(pos);
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
          else if (ch === ">" && depth <= 0) {
            pos++;
            break;
          }
          pos++;
        }
      } else {
        return;
      }
    }
  }

  function parseName(): string {
    const start = pos;
    while (pos < input.length && /[^\s=/>]/.test(input.charAt(pos))) pos++;
    if (pos === start) fail("expected a name");
    return input.slice(start, pos);
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWhitespace();
      const ch = input.charAt(pos);
      if (ch === ">" || ch === "/" || ch === "") return attrs;
      const name = parseName();
      skipWhitespace();
      if (input.charAt(pos) !== "=") fail(`expected '=' after attribute ${name}`);
      pos++;
      skipWhitespace();
      const quote = input.charAt(pos);
      if (quote !== '"' && quote !== "'") fail("expected quoted attribute value");
      pos++;
      const end = input.indexOf(quote, pos);
      if (end === -1) fail("unterminated attribute value");
      attrs[name] = decodeEntities(input.slice(pos, end));
      pos = end + 1;
    }
  }

  function parseElement(): XmlElement {
    if (input.charAt(pos) !== "<") fail("expected '<'");
    pos++;
    const name = parseName();
    const attrs = parseAttrs();
    const element: XmlElement = { name, attrs, children: [] };
    if (input.startsWith("/>", pos)) {
      pos += 2;
      return element;
    }
    if (input.charAt(pos) !== ">") fail(`malformed start tag <${name}>`);
    pos++;
    // Children until matching close tag.
    for (;;) {
      if (pos >= input.length) fail(`unterminated element <${name}>`);
      if (input.startsWith("</", pos)) {
        pos += 2;
        const closeName = parseName();
        if (closeName !== name) fail(`mismatched close tag </${closeName}> for <${name}>`);
        skipWhitespace();
        if (input.charAt(pos) !== ">") fail("malformed close tag");
        pos++;
        return element;
      }
      if (input.startsWith("<![CDATA[", pos)) {
        const end = input.indexOf("]]>", pos);
        if (end === -1) fail("unterminated CDATA section");
        element.children.push(input.slice(pos + 9, end));
        pos = end + 3;
      } else if (input.startsWith("<!--", pos)) {
        const end = input.indexOf("-->", pos);
        if (end === -1) fail("unterminated comment");
        pos = end + 3;
      } else if (input.startsWith("<?", pos)) {
        const end = input.indexOf("?>", pos);
        if (end === -1) fail("unterminated processing instruction");
        pos = end + 2;
      } else if (input.charAt(pos) === "<") {
        element.children.push(parseElement());
      } else {
        const next = input.indexOf("<", pos);
        const end = next === -1 ? input.length : next;
        const text = decodeEntities(input.slice(pos, end));
        if (text.length > 0) element.children.push(text);
        pos = end;
      }
    }
  }

  skipMisc();
  const root = parseElement();
  skipMisc();
  return root;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

export function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== "string";
}

/** Direct children elements, optionally filtered by tag name. */
export function children(el: XmlElement, name?: string): XmlElement[] {
  const elems = el.children.filter(isElement);
  return name === undefined ? elems : elems.filter((c) => c.name === name);
}

/** First direct child element with the given tag name, or undefined. */
export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((n): n is XmlElement => isElement(n) && n.name === name);
}

/** Concatenated direct text content of an element, whitespace-trimmed. */
export function textOf(el: XmlElement | undefined): string {
  if (el === undefined) return "";
  return el.children
    .filter((n): n is string => typeof n === "string")
    .join("")
    .trim();
}

/** Trimmed text of a named direct child ("" when absent). */
export function childText(el: XmlElement, name: string): string {
  return textOf(child(el, name));
}

/** Walk a path of child-element names; undefined when any hop is missing. */
export function descend(el: XmlElement, ...path: string[]): XmlElement | undefined {
  let current: XmlElement | undefined = el;
  for (const name of path) {
    if (current === undefined) return undefined;
    current = child(current, name);
  }
  return current;
}

/** All descendant elements (depth-first) with the given tag name. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [el];
  while (stack.length > 0) {
    const current = stack.pop() as XmlElement;
    for (const c of children(current)) {
      if (c.name === name) out.push(c);
      stack.push(c);
    }
  }
  return out;
}
