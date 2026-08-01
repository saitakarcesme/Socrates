export type SandboxTerminationReceipt =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "terminated"; forced: boolean }>;

export function sandboxTerminationReceipt(
  candidate: unknown,
): SandboxTerminationReceipt {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("Sandbox termination receipt must be an object.");
  }
  const value = candidate as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (value["state"] === "absent" && keys.length === 1 && keys[0] === "state") {
    return Object.freeze({ state: "absent" });
  }
  if (
    value["state"] === "terminated" &&
    typeof value["forced"] === "boolean" &&
    keys.length === 2 &&
    keys[0] === "forced" &&
    keys[1] === "state"
  ) {
    return Object.freeze({ state: "terminated", forced: value["forced"] });
  }
  throw new TypeError("Sandbox termination receipt is invalid.");
}
