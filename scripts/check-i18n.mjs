#!/usr/bin/env node
/**
 * Verifies every locale against English:
 *  - missing / extra keys
 *  - mismatched {placeholders}
 *  - array length differences
 * Active locales fail the check; planned locales only warn.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/i18n/messages");
const configSrc = readFileSync(join(root, "src/i18n/config.ts"), "utf8");

const statuses = {};
for (const m of configSrc.matchAll(/^\s{2}(\w+): \{\s*\n\s*status: "(active|planned)"/gm)) {
  statuses[m[1]] = m[2];
}

const ref = "en";
const namespaces = readdirSync(join(dir, ref)).filter((f) => f.endsWith(".json"));

function flatten(obj, prefix = "", out = {}) {
  if (Array.isArray(obj)) {
    out[prefix] = { array: obj.length };
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = { value: String(obj) };
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

let errors = 0;
let warnings = 0;

for (const locale of Object.keys(statuses)) {
  if (locale === ref) continue;
  const level = statuses[locale] === "active" ? "error" : "warn";
  const issues = [];
  for (const ns of namespaces) {
    const file = join(dir, locale, ns);
    if (!existsSync(file)) {
      issues.push(`${ns}: file missing`);
      continue;
    }
    const a = flatten(JSON.parse(readFileSync(join(dir, ref, ns), "utf8")));
    const b = flatten(JSON.parse(readFileSync(file, "utf8")));
    for (const k of Object.keys(a)) {
      if (!(k in b)) issues.push(`${ns}: missing "${k}"`);
      else if (a[k].array !== undefined && a[k].array !== b[k].array)
        issues.push(`${ns}: "${k}" has ${b[k].array} items, expected ${a[k].array}`);
      else if (a[k].value !== undefined && placeholders(a[k].value) !== placeholders(b[k].value ?? ""))
        issues.push(`${ns}: "${k}" placeholders differ`);
      else if (b[k].value !== undefined && b[k].value.trim() === "")
        issues.push(`${ns}: "${k}" is empty`);
    }
    for (const k of Object.keys(b)) if (!(k in a)) issues.push(`${ns}: extra "${k}"`);
  }
  const tag = `[${locale} · ${statuses[locale]}]`;
  if (issues.length === 0) {
    console.log(`✓ ${tag} complete`);
  } else if (level === "error") {
    errors += issues.length;
    console.error(`✗ ${tag} ${issues.length} issue(s)`);
    issues.forEach((i) => console.error(`    ${i}`));
  } else {
    warnings += issues.length;
    console.warn(`! ${tag} not yet translated (${issues.length} gaps; falls back to English)`);
  }
}

if (errors) {
  console.error(`\ni18n check failed: ${errors} issue(s) in active locales.`);
  process.exit(1);
}
console.log(`\ni18n check passed${warnings ? ` (${warnings} warnings in planned locales)` : ""}.`);
