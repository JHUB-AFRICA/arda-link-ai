/**
 * GPT sometimes emits literal control characters (newline, tab, etc.)
 * inside JSON string values instead of their escape sequences.
 * Walk the raw string character-by-character and escape any bare control
 * characters that appear inside a JSON string value.
 */
export function sanitizeJsonString(raw: string): string {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      out += ch;
      inStr = !inStr;
      continue;
    }
    if (inStr && ch.charCodeAt(0) < 0x20) {
      // Bare control character inside a string — escape it
      if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      // other control chars: drop them
      continue;
    }
    out += ch;
  }
  return out;
}
