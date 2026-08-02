export type PlainDataStructurePolicy = Readonly<{
  arrays: "allow" | "reject";
  maximumDepth?: number;
  maximumNodes?: number;
}>;

function positiveLimit(value: number | undefined, field: string): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function dataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  enumerable: boolean,
): descriptor is PropertyDescriptor & { value: unknown } {
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined &&
    descriptor.enumerable === enumerable
  );
}

export function assertPlainDataStructure(
  candidate: unknown,
  policy: PlainDataStructurePolicy,
): void {
  const maximumDepth = positiveLimit(policy.maximumDepth, "maximumDepth");
  const maximumNodes = positiveLimit(policy.maximumNodes, "maximumNodes");
  const active = new Set<object>();
  let nodes = 0;

  const visit = (value: unknown, parentDepth: number): void => {
    nodes += 1;
    if (nodes > maximumNodes) {
      throw new TypeError("Plain data contains too many nodes.");
    }
    if (value === null) return;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError("Candidate must contain only plain data.");
    }
    if (active.has(value)) {
      throw new TypeError("Plain data cannot contain cycles.");
    }
    const depth = parentDepth + 1;
    if (depth > maximumDepth) {
      throw new TypeError("Plain data is nested too deeply.");
    }

    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new TypeError("Plain data cannot contain symbol keys.");
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (policy.arrays === "reject" || prototype !== Array.prototype) {
          throw new TypeError("Candidate arrays are not admitted.");
        }
        const lengthDescriptor = descriptors["length"];
        if (!dataDescriptor(lengthDescriptor, false)) {
          throw new TypeError("Plain arrays must have a data length.");
        }
        const length = lengthDescriptor.value;
        if (!Number.isSafeInteger(length) || (length as number) < 0) {
          throw new TypeError("Plain array length is invalid.");
        }
        for (let index = 0; index < (length as number); index += 1) {
          const descriptor = descriptors[String(index)];
          if (!dataDescriptor(descriptor, true)) {
            throw new TypeError("Plain arrays must be dense data arrays.");
          }
          visit(descriptor.value, depth);
        }
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== (length as number) + 1) {
          throw new TypeError("Plain arrays cannot contain extension keys.");
        }
        return;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Candidate objects must use plain prototypes.");
      }
      for (const descriptor of Object.values(descriptors)) {
        if (!dataDescriptor(descriptor, true)) {
          throw new TypeError("Plain object properties must contain data.");
        }
        visit(descriptor.value, depth);
      }
    } finally {
      active.delete(value);
    }
  };

  visit(candidate, 0);
}

export function deepFreezePlainData<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreezePlainData(child);
  return Object.freeze(value);
}
