/**
 * Standalone replacement for `src/l10n.ts` with no VS Code dependency.
 *
 * Loads the English base bundle (`l10n/bundle.l10n.json`) and resolves keys with
 * the same `{0}` / `{name}` interpolation the original uses. The webview never
 * sees this module directly — it receives a pre-resolved string table injected
 * into the page by `webviewHtml.ts`. This module exists so `getWebviewLocalizedStrings`
 * (reused from `src/extension/webviewL10n.ts`) resolves against the standalone bundle.
 */
import * as fs from "node:fs";
import * as path from "node:path";

let translations: Record<string, string> = {};

export function initL10n(l10nDir: string): void {
  try {
    translations = JSON.parse(
      fs.readFileSync(path.join(l10nDir, "bundle.l10n.json"), "utf8")
    ) as Record<string, string>;
  } catch {
    translations = {};
  }
}

function interpolate(
  template: string,
  args: Array<string | number | boolean> | Record<string, string | number | boolean>
): string {
  if (Array.isArray(args)) {
    return template.replace(/\{(\d+)\}/g, (_, index) => {
      const value = args[parseInt(index, 10)];
      return value !== undefined ? String(value) : `{${index}}`;
    });
  }
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = args[key];
    return value !== undefined ? String(value) : `{${key}}`;
  });
}

export function t(key: string, ...args: Array<string | number | boolean>): string;
export function t(key: string, args: Record<string, string | number | boolean>): string;
export function t(
  key: string,
  ...args: Array<string | number | boolean | Record<string, string | number | boolean>>
): string {
  const template = translations[key];
  if (!template) return key;
  if (args.length === 1 && typeof args[0] === "object" && !Array.isArray(args[0])) {
    return interpolate(template, args[0] as Record<string, string | number | boolean>);
  }
  if (args.length > 0) {
    return interpolate(template, args as Array<string | number | boolean>);
  }
  return template;
}
