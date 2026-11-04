/**
 * Minimal, dependency-free translator.
 *  - Dotted keys:          t("hero.title")
 *  - Interpolation:        t("plan.price", { amount: "$9" })  ->  "{amount}" replaced
 *  - Structured content:   t.raw("faq.items") returns arrays/objects as-is
 */

type Primitive = string | number | boolean | null | undefined;

/** All dotted paths in T that resolve to a string. */
export type StringPaths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends readonly unknown[]
      ? never
      : T[K] extends object
        ? StringPaths<T[K], `${P}${K}.`>
        : never;
}[keyof T & string];

/** All dotted paths in T (any value). */
export type AnyPaths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends readonly unknown[]
    ? `${P}${K}`
    : T[K] extends object
      ? `${P}${K}` | AnyPaths<T[K], `${P}${K}.`>
      : `${P}${K}`;
}[keyof T & string];

type PathValue<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? PathValue<T[H], R>
    : never
  : P extends keyof T
    ? T[P]
    : never;

export interface Translator<T> {
  (key: StringPaths<T>, vars?: Record<string, Primitive>): string;
  raw<P extends AnyPaths<T>>(key: P): PathValue<T, P>;
}

/**
 * Resolve a dotted key. Technical identifiers such as "trigger.webhook" or
 * "auth.invalid_credentials" are stored as literal keys, so at each level the
 * longest matching key wins: "trigger.webhook.label" -> obj["trigger.webhook"]["label"].
 */
function resolve(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const record = obj as Record<string, unknown>;
  if (key in record) return record[key];
  const parts = key.split(".");
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join(".");
    if (head in record) {
      const found = resolve(record[head], parts.slice(i).join("."));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function interpolate(template: string, vars?: Record<string, Primitive>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined || vars[name] === null ? match : String(vars[name]),
  );
}

export function createTranslator<T>(messages: T, namespace: string): Translator<T> {
  const t = ((key: string, vars?: Record<string, Primitive>) => {
    const value = resolve(messages, key);
    if (typeof value !== "string") {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[i18n] Missing string "${namespace}.${key}"`);
      }
      return `${namespace}.${key}`;
    }
    return interpolate(value, vars);
  }) as unknown as Translator<T>;
  t.raw = ((key: string) => resolve(messages, key)) as unknown as Translator<T>["raw"];
  return t;
}
