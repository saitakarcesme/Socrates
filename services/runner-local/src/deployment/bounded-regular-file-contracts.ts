export const maximumNodeBoundedRegularFileBytes = 16_777_216;
export const maximumNodeBoundedRegularFilePathBytes = 4_096;

export type NodeBoundedRegularFileReadErrorCode =
  | "invalid_input"
  | "unsupported_host"
  | "open_failed"
  | "invalid_metadata"
  | "size_limit"
  | "read_failed"
  | "content_changed"
  | "close_failed";

export class NodeBoundedRegularFileReadError extends Error {
  constructor(readonly code: NodeBoundedRegularFileReadErrorCode) {
    super(`Bounded regular-file read failed ${code}.`);
    this.name = "NodeBoundedRegularFileReadError";
    Object.freeze(this);
  }
}

export type NodeBoundedRegularFileReadRequest = Readonly<{
  path: string;
  maximumBytes: number;
  expectedOwnerUid: number;
  mode: number;
}>;

export function boundedRegularFileReadFailure(
  code: NodeBoundedRegularFileReadErrorCode,
): never {
  throw new NodeBoundedRegularFileReadError(code);
}
