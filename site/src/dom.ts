/**
 * Tiny DOM construction helper — the site builds real nodes instead of the
 * prototype's innerHTML strings, so member names, filing titles and X quotes
 * are always inserted as text, never parsed as HTML.
 */

export type Child = Node | string | number | null | undefined | false;

/** Create an element, set attributes, append children (strings become text nodes). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number | boolean>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false) continue;
    if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, ...children);
  return node;
}

/** Append children, skipping null/undefined/false. */
export function append(node: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replace an element's children wholesale. */
export function replaceChildren(node: Element, ...children: Child[]): void {
  node.replaceChildren();
  append(node, ...children);
}
