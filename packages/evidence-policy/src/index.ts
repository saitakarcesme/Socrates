const redactedMarker = "[REDACTED]";

const secretPatterns: readonly {
  pattern: RegExp;
  replacement: string;
}[] = [
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replacement: `$1${redactedMarker}`,
  },
  {
    pattern:
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
    replacement: `$1$2$3${redactedMarker}$3`,
  },
  {
    pattern:
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16})\b/g,
    replacement: redactedMarker,
  },
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED PRIVATE KEY]",
  },
];

export type RedactedText = Readonly<{
  text: string;
  matched: boolean;
}>;

export function redactEvidenceText(input: string): RedactedText {
  let text = input;
  for (const { pattern, replacement } of secretPatterns) {
    text = text.replace(pattern, replacement);
  }
  return Object.freeze({ text, matched: text !== input });
}
