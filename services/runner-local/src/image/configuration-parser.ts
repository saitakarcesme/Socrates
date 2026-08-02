import {
  assertPlainDataStructure,
  deepFreezePlainData,
} from "../configuration/plain-data";
import {
  localRunnerTrustedImageCatalogConfigurationV1Schema,
  maximumTrustedImageConfigurationDepth,
  maximumTrustedImageConfigurationNodes,
  type LocalRunnerTrustedImageCatalogConfigurationV1,
} from "./configuration-contracts";

export class LocalRunnerTrustedImageConfigurationError extends Error {
  constructor(
    readonly code: "invalid_candidate" | "invalid_configuration",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalRunnerTrustedImageConfigurationError";
    Object.freeze(this);
  }
}

export function parseLocalRunnerTrustedImageCatalogConfiguration(
  candidate: unknown,
): LocalRunnerTrustedImageCatalogConfigurationV1 {
  try {
    assertPlainDataStructure(candidate, {
      arrays: "allow",
      maximumDepth: maximumTrustedImageConfigurationDepth,
      maximumNodes: maximumTrustedImageConfigurationNodes,
    });
  } catch (cause) {
    throw new LocalRunnerTrustedImageConfigurationError(
      "invalid_candidate",
      "Trusted image configuration candidate is not plain bounded data.",
      { cause },
    );
  }
  let parsed;
  try {
    parsed =
      localRunnerTrustedImageCatalogConfigurationV1Schema.safeParse(candidate);
  } catch (cause) {
    throw new LocalRunnerTrustedImageConfigurationError(
      "invalid_candidate",
      "Trusted image configuration candidate is not plain bounded data.",
      { cause },
    );
  }
  if (!parsed.success) {
    throw new LocalRunnerTrustedImageConfigurationError(
      "invalid_configuration",
      "Trusted image configuration is invalid.",
      { cause: parsed.error },
    );
  }
  return deepFreezePlainData(parsed.data);
}
