/** Lenient readers for untrusted JSON: wrong-typed values collapse to an empty default. */
export const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const text = (value: unknown): string => (typeof value === "string" ? value : "");
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
