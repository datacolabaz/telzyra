/**
 * Template resolution for step inputs: {{ trigger.chat.id }}, {{ steps.append.updated_range }}, {{ now }}.
 * Pure path lookup — no code evaluation. A value that is exactly one template keeps its original
 * type (number, object…); templates embedded in text are converted to strings.
 */
const TEMPLATE = /\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}/g;
const SINGLE = /^\{\{\s*([A-Za-z_][\w]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function lookup(scope: Record<string, unknown>, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (FORBIDDEN.has(p) || cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const stringify = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function resolveTemplates(value: unknown, scope: Record<string, unknown>, depth = 0): unknown {
  if (depth > 20) return value;
  if (typeof value === "string") {
    const single = value.match(SINGLE);
    if (single) return lookup(scope, single[1]!);
    return value.replace(TEMPLATE, (_m, path: string) => stringify(lookup(scope, path)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, scope, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !FORBIDDEN.has(k)).map(([k, v]) => [k, resolveTemplates(v, scope, depth + 1)]));
  }
  return value;
}

/** Keeps stored step outputs bounded. */
export function truncateForStorage(value: unknown, maxBytes = 64 * 1024): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxBytes) return value ?? null;
  return { truncated: true, preview: json.slice(0, 2000) };
}
