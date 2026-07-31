import type { z } from "zod";

const headerBytes = 4;
const textEncoder = new TextEncoder();

export class RuntimeProtocolError extends Error {
  constructor(
    readonly code:
      | "aggregate_limit"
      | "frame_limit"
      | "frame_size"
      | "invalid_json"
      | "invalid_schema"
      | "invalid_utf8"
      | "non_canonical"
      | "truncated",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeProtocolError";
  }
}

export type DecoderLimits = Readonly<{
  maximumFrameBytes: number;
  maximumAggregateBytes: number;
  maximumFrames: number;
}>;

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entry]) => [name, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(canonicalValue(value));
  if (json === undefined) {
    throw new TypeError("Runtime protocol value is not JSON serializable.");
  }
  return json;
}

export function encodeRuntimeMessage<T>(
  schema: z.ZodType<T>,
  value: unknown,
  maximumFrameBytes: number,
): Uint8Array {
  positiveLimit("maximumFrameBytes", maximumFrameBytes);
  const parsed = schema.parse(value);
  const payload = textEncoder.encode(canonicalJson(parsed));
  if (payload.byteLength > maximumFrameBytes) {
    throw new RuntimeProtocolError(
      "frame_size",
      "Runtime protocol message exceeds its frame limit.",
    );
  }
  const encoded = new Uint8Array(headerBytes + payload.byteLength);
  new DataView(encoded.buffer).setUint32(0, payload.byteLength, false);
  encoded.set(payload, headerBytes);
  return encoded;
}

export class RuntimeMessageDecoder<T> {
  readonly #schema: z.ZodType<T>;
  readonly #limits: DecoderLimits;
  #buffer = new Uint8Array();
  #aggregateBytes = 0;
  #frames = 0;
  #finished = false;

  constructor(schema: z.ZodType<T>, limits: DecoderLimits) {
    positiveLimit("maximumFrameBytes", limits.maximumFrameBytes);
    positiveLimit("maximumAggregateBytes", limits.maximumAggregateBytes);
    positiveLimit("maximumFrames", limits.maximumFrames);
    if (limits.maximumFrameBytes > limits.maximumAggregateBytes) {
      throw new RangeError(
        "maximumFrameBytes cannot exceed maximumAggregateBytes.",
      );
    }
    this.#schema = schema;
    this.#limits = Object.freeze({ ...limits });
  }

  push(chunk: Uint8Array): readonly T[] {
    if (this.#finished) {
      throw new RuntimeProtocolError(
        "truncated",
        "Runtime decoder is already finished.",
      );
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Runtime protocol chunks must be binary.");
    }
    this.#aggregateBytes += chunk.byteLength;
    if (this.#aggregateBytes > this.#limits.maximumAggregateBytes) {
      throw new RuntimeProtocolError(
        "aggregate_limit",
        "Runtime protocol stream exceeds its aggregate limit.",
      );
    }
    const combined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    combined.set(this.#buffer);
    combined.set(chunk, this.#buffer.byteLength);
    this.#buffer = combined;

    const messages: T[] = [];
    while (this.#buffer.byteLength >= headerBytes) {
      const length = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset,
        headerBytes,
      ).getUint32(0, false);
      if (length > this.#limits.maximumFrameBytes) {
        throw new RuntimeProtocolError(
          "frame_size",
          "Runtime protocol frame exceeds its limit.",
        );
      }
      if (this.#buffer.byteLength < headerBytes + length) break;
      this.#frames += 1;
      if (this.#frames > this.#limits.maximumFrames) {
        throw new RuntimeProtocolError(
          "frame_limit",
          "Runtime protocol stream contains too many frames.",
        );
      }
      const payload = this.#buffer.subarray(headerBytes, headerBytes + length);
      this.#buffer = this.#buffer.slice(headerBytes + length);
      messages.push(this.#decode(payload));
    }
    return messages;
  }

  finish(): void {
    this.#finished = true;
    if (this.#buffer.byteLength !== 0) {
      throw new RuntimeProtocolError(
        "truncated",
        "Runtime protocol stream ended within a frame.",
      );
    }
  }

  #decode(payload: Uint8Array): T {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    } catch (cause) {
      throw new RuntimeProtocolError(
        "invalid_utf8",
        "Runtime protocol frame is not valid UTF-8.",
        { cause },
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new RuntimeProtocolError(
        "invalid_json",
        "Runtime protocol frame is not valid JSON.",
        { cause },
      );
    }
    const parsed = this.#schema.safeParse(value);
    if (!parsed.success) {
      throw new RuntimeProtocolError(
        "invalid_schema",
        "Runtime protocol frame does not match its schema.",
        { cause: parsed.error },
      );
    }
    if (canonicalJson(parsed.data) !== text) {
      throw new RuntimeProtocolError(
        "non_canonical",
        "Runtime protocol frame is not canonical JSON.",
      );
    }
    return parsed.data;
  }
}
