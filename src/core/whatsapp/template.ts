/**
 * WhatsApp template rendering.
 *
 * WhatsApp uses plain-text only (no HTML, no tracking pixel).
 * Templates use `{{variable}}` substitution — same syntax as email templates.
 *
 * Supported default variables: firstName, companyName.
 * Unknown / missing variables are left as their original `{{placeholder}}` token.
 */

const VARIABLE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Substitute {{var}} tokens; missing variables keep their placeholder */
export function renderSimpleTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(VARIABLE_PATTERN, (match, key: string) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : match;
  });
}