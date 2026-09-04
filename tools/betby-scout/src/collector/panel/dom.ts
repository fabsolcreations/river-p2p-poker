/**
 * Minimal DOM builder for the debug panel. No framework, no dependencies.
 *
 * The one rule that matters here: there is no `innerHTML` path anywhere in this
 * file, and no caller can introduce one. Everything the panel displays is
 * derived from payloads captured off a third-party page, so a response body
 * containing `<img src=x onerror=...>` is not a hypothetical - it is a string we
 * will absolutely render. Text always becomes a text node and attributes are
 * always set through `setAttribute`, both of which treat markup as characters.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElOptions {
  class?: string;
  /** Appended as a text node. Never parsed as markup. */
  text?: string | number;
  /** Native tooltip. Safe for untrusted strings - attributes are not parsed. */
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Record<string, (ev: Event) => void>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.class) node.setAttribute('class', opts.class);
  if (opts.text !== undefined) node.appendChild(document.createTextNode(String(opts.text)));
  if (opts.title !== undefined) node.setAttribute('title', opts.title);
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (opts.on) {
    for (const [type, fn] of Object.entries(opts.on)) node.addEventListener(type, fn);
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child | Child[]): void {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) append(parent, c);
    return;
  }
  if (typeof children === 'string' || typeof children === 'number') {
    parent.appendChild(document.createTextNode(String(children)));
    return;
  }
  parent.appendChild(children);
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** `textContent` assignment, isolated here so no caller reaches for innerHTML. */
export function setText(node: Node, value: string | number): void {
  node.textContent = String(value);
}

/** Show/hide via the `hidden` attribute; the panel CSS forces display:none. */
export function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}
