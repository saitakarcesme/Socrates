import {
  localRunnerConfigurationV1Schema,
  type LocalRunnerConfigurationV1,
} from "./contracts";
import { assertPlainDataStructure, deepFreezePlainData } from "./plain-data";

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

export function parseLocalRunnerConfiguration(
  candidate: unknown,
): LocalRunnerConfigurationV1 {
  try {
    assertPlainDataStructure(candidate, { arrays: "reject" });
  } catch (cause) {
    throw new LocalRunnerConfigurationError(
      "invalid_candidate",
      "Local runner configuration candidate is not plain data.",
      { cause },
    );
  }
  let parsed;
  try {
    parsed = localRunnerConfigurationV1Schema.safeParse(candidate);
  } catch (cause) {
    throw new LocalRunnerConfigurationError(
      "invalid_candidate",
      "Local runner configuration candidate is not plain data.",
      { cause },
    );
  }
  if (!parsed.success) {
    throw new LocalRunnerConfigurationError(
      "invalid_configuration",
      "Local runner configuration is invalid.",
      { cause: parsed.error },
    );
  }
  return deepFreezePlainData(parsed.data);
}
