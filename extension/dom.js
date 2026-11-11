/**
 * Look up a form control (input, select, button) by id. Typed as `any` on purpose: the element
 * kind is decided by the HTML page, and `getElementById` would only say "some HTMLElement",
 * which has no `.value`, `.checked` or `.disabled`.
 * @param {string} id
 * @returns {any}
 */
export function control(id) {
  return document.getElementById(id);
}
