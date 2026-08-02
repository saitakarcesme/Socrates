import {
  localRunnerConfigurationV1Schema,
  type LocalRunnerConfigurationV1,
} from "./contracts";

export class LocalRunnerConfigurationError extends Error {
  constructor(
    readonly code: "invalid_candidate" | "invalid_configuration",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalRunnerConfigurationError";
  }
}

function assertPlainData(candidate: unknown, seen = new Set<object>()): void {
  if (candidate === null) return;
  if (
    typeof candidate === "string" ||
    typeof candidate === "number" ||
    typeof candidate === "boolean"
  ) {
    return;
  }
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Configuration candidate must contain plain data.");
  }
  if (seen.has(candidate)) {
    throw new TypeError("Configuration candidate cannot contain cycles.");
  }
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Configuration candidate must use plain objects.");
  }
  if (Object.getOwnPropertySymbols(candidate).length !== 0) {
    throw new TypeError("Configuration candidate cannot contain symbol keys.");
  }
  seen.add(candidate);
  const descriptors = Object.getOwnPropertyDescriptors(candidate);
  for (const descriptor of Object.values(descriptors)) {
    if (
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError("Configuration candidate properties must be data.");
    }
    assertPlainData(descriptor.value, seen);
  }
  seen.delete(candidate);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseLocalRunnerConfiguration(
  candidate: unknown,
): LocalRunnerConfigurationV1 {
  try {
    assertPlainData(candidate);
  } catch (cause) {
    throw new LocalRunnerConfigurationError(
      "invalid_candidate",
      "Local runner configuration candidate is not plain data.",
      { cause },
    );
  }
  const parsed = localRunnerConfigurationV1Schema.safeParse(candidate);
  if (!parsed.success) {
    throw new LocalRunnerConfigurationError(
      "invalid_configuration",
      "Local runner configuration is invalid.",
      { cause: parsed.error },
    );
  }
  return deepFreeze(parsed.data);
}
