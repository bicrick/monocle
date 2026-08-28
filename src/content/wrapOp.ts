/**
 * Wrap must not relocate page-owned nodes. Moving a React/Vue-managed
 * element (the jade-scroll parchment wrap) throws on the next render and
 * takes the tab down after apply.
 */

import { INSERT_MARK } from "./runtime";

export const WRAP_KIND = "wrap";
export const WRAP_INPLACE_KIND = "wrap-inplace";
export const WRAP_CLASS_ATTR = "data-monacle-wrap-class";

export function parseWrapClasses(wrapClass?: string): string[] {
  return (wrapClass || "").split(/\s+/).filter(Boolean);
}

export function isAlreadyWrapped(el: Element, mark: string): boolean {
  const kind = el.getAttribute(mark);
  if (kind === WRAP_KIND || kind === WRAP_INPLACE_KIND) return true;
  return el.parentElement?.getAttribute(mark) === WRAP_KIND;
}

function stampWrapClass(el: Element, mark: string, wrapClass?: string): void {
  const classes = parseWrapClasses(wrapClass);
  if (classes.length) {
    el.classList.add(...classes);
    el.setAttribute(WRAP_CLASS_ATTR, classes.join(" "));
  }
  el.setAttribute(mark, WRAP_INPLACE_KIND);
}

/** Relocate only Monacle-owned nodes; stamp a class onto page-owned ones. */
export function applyWrap(
  el: Element,
  mark: string,
  wrapTag?: string,
  wrapClass?: string,
): void {
  if (isAlreadyWrapped(el, mark)) return;

  if (!el.hasAttribute(INSERT_MARK)) {
    stampWrapClass(el, mark, wrapClass);
    return;
  }

  const wrapper = document.createElement(wrapTag || "div");
  if (wrapClass) wrapper.className = wrapClass;
  wrapper.setAttribute(mark, WRAP_KIND);
  el.parentElement?.insertBefore(wrapper, el);
  wrapper.appendChild(el);
}

/** Undo wrap. Returns true when this node was a wrap mark. */
export function revertWrap(el: Element, mark: string): boolean {
  const kind = el.getAttribute(mark);
  if (kind === WRAP_INPLACE_KIND) {
    const classes = parseWrapClasses(
      el.getAttribute(WRAP_CLASS_ATTR) || undefined,
    );
    if (classes.length) el.classList.remove(...classes);
    el.removeAttribute(WRAP_CLASS_ATTR);
    el.removeAttribute(mark);
    return true;
  }
  if (kind === WRAP_KIND) {
    const parent = el.parentElement;
    while (el.firstChild) parent?.insertBefore(el.firstChild, el);
    el.remove();
    return true;
  }
  return false;
}
