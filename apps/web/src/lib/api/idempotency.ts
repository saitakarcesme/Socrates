export type IdempotencyKeyState = {
  fingerprint: string;
  key: string;
};

export function idempotencyKeyFor(
  payload: unknown,
  current: IdempotencyKeyState | null,
  generate: () => string = () => crypto.randomUUID(),
): IdempotencyKeyState {
  const fingerprint = JSON.stringify(payload);
  if (current?.fingerprint === fingerprint) {
    return current;
  }

  return {
    fingerprint,
    key: `web:${generate()}`,
  };
}
