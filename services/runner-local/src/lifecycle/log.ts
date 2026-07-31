import { redactEvidenceText } from "@socrates/evidence-policy";

import { runnerEventDraft, type RunnerEventDraft } from "./draft";

const maximumTextCharacters = 16_384;
const maximumTextBytes = 65_536;
const encoder = new TextEncoder();

export class RuntimeLogBudgetError extends Error {
  constructor(readonly attemptedBytes: number) {
    super("Runtime logs exceed the frozen log byte budget.");
    this.name = "RuntimeLogBudgetError";
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function decode(bytes: Uint8Array): Readonly<{
  text: string;
  invalidUtf8: boolean;
}> {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      invalidUtf8: false,
    };
  } catch {
    return {
      text: new TextDecoder("utf-8").decode(bytes),
      invalidUtf8: true,
    };
  }
}

function chunksWithinContract(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of text) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (
      current.length > 0 &&
      (current.length + codePoint.length > maximumTextCharacters ||
        currentBytes + codePointBytes > maximumTextBytes)
    ) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function runtimeLogDrafts(input: {
  stream: "stderr" | "stdout";
  chunks: readonly Uint8Array[];
  remainingBudgetBytes: number;
}): Readonly<{
  drafts: readonly RunnerEventDraft[];
  utf8Bytes: number;
}> {
  if (
    !Number.isSafeInteger(input.remainingBudgetBytes) ||
    input.remainingBudgetBytes < 0
  ) {
    throw new RangeError(
      "remainingBudgetBytes must be a non-negative safe integer.",
    );
  }
  const decoded = decode(concatenate(input.chunks));
  const redacted = redactEvidenceText(decoded.text);
  const utf8Bytes = encoder.encode(redacted.text).byteLength;
  if (utf8Bytes > input.remainingBudgetBytes) {
    throw new RuntimeLogBudgetError(utf8Bytes);
  }
  const drafts = chunksWithinContract(redacted.text).map((text) =>
    runnerEventDraft({
      type: "log.appended",
      payload: {
        stream: input.stream,
        text,
        utf8Bytes: encoder.encode(text).byteLength,
        redacted: decoded.invalidUtf8 || redacted.matched,
      },
    }),
  );
  return Object.freeze({
    drafts: Object.freeze(drafts),
    utf8Bytes,
  });
}
