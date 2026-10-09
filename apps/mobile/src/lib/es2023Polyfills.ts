/**
 * The ES2023 array methods Hermes does not ship, filled in only where missing.
 *
 * The app shares loop's handlers with the web and desktop clients, which run on
 * engines that have them, so a `.toSorted()` there passes every test and then
 * throws `undefined is not a function` on the phone. It did: the live-turn fold
 * sorted with it, every mid-turn rebuild failed silently, and a reply appeared
 * only once the turn had ended. Loaded first, before any of that code runs.
 */

type Mutable = unknown[];

function define(name: string, value: (this: Mutable, ...args: never[]) => unknown): void {
  if (typeof (Array.prototype as unknown as Record<string, unknown>)[name] === "function") return;
  Object.defineProperty(Array.prototype, name, { value, writable: true, configurable: true });
}

define("toSorted", function (this: Mutable, compare?: (a: unknown, b: unknown) => number) {
  return Array.prototype.slice.call(this).sort(compare);
});
define("toReversed", function (this: Mutable) {
  return Array.prototype.slice.call(this).reverse();
});
define("toSpliced", function (this: Mutable, ...args: never[]) {
  const copy = Array.prototype.slice.call(this);
  (copy.splice as (...a: unknown[]) => unknown)(...args);
  return copy;
});
define("with", function (this: Mutable, index: number, value: unknown) {
  const copy = Array.prototype.slice.call(this);
  const at = index < 0 ? copy.length + index : index;
  if (at < 0 || at >= copy.length) throw new RangeError("Invalid index");
  copy[at] = value;
  return copy;
});
define("findLast", function (this: Mutable, predicate: (value: unknown, index: number, array: Mutable) => unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return this[i];
  return undefined;
});
define("findLastIndex", function (this: Mutable, predicate: (value: unknown, index: number, array: Mutable) => unknown) {
  for (let i = this.length - 1; i >= 0; i--) if (predicate(this[i], i, this)) return i;
  return -1;
});
