export function captureCapabilityMethod<
  Arguments extends readonly unknown[],
  Result,
>(owner: unknown, name: PropertyKey): (...arguments_: Arguments) => Result {
  if ((typeof owner !== "object" && typeof owner !== "function") || !owner) {
    throw new TypeError("Capability owner is invalid.");
  }
  const candidate = Reflect.get(owner, name) as unknown;
  if (typeof candidate !== "function") {
    throw new TypeError("Capability method is not callable.");
  }
  return Reflect.apply(Function.prototype.bind, candidate, [owner]) as (
    ...arguments_: Arguments
  ) => Result;
}

export function captureCapabilityFunction<
  Arguments extends readonly unknown[],
  Result,
>(candidate: unknown): (...arguments_: Arguments) => Result {
  if (typeof candidate !== "function") {
    throw new TypeError("Capability is not callable.");
  }
  return Reflect.apply(Function.prototype.bind, candidate, [undefined]) as (
    ...arguments_: Arguments
  ) => Result;
}
