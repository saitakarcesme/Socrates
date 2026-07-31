export type SourcePathLimits = Readonly<{
  maximumPathBytes: number;
  maximumComponentBytes: number;
  maximumPathDepth: number;
}>;

type PathKind = "directory" | "file";

type RegisteredPath = {
  kind: PathKind;
  explicit: boolean;
};

const forbiddenCharacters = /[<>:"|?*\\]/u;
const driveQualifiedPath = /^[a-z]:/iu;
const reservedComponent = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function positiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0xfffd
    );
  });
}

export function validateSourcePathLimits(limits: SourcePathLimits): void {
  positiveLimit("maximumPathBytes", limits.maximumPathBytes);
  positiveLimit("maximumComponentBytes", limits.maximumComponentBytes);
  positiveLimit("maximumPathDepth", limits.maximumPathDepth);
  if (limits.maximumComponentBytes > limits.maximumPathBytes) {
    throw new RangeError(
      "maximumComponentBytes cannot exceed maximumPathBytes.",
    );
  }
}

export function canonicalSourcePath(
  archiveName: string,
  kind: PathKind,
  limits: SourcePathLimits,
): string {
  validateSourcePathLimits(limits);
  const name =
    kind === "directory" && archiveName.endsWith("/")
      ? archiveName.slice(0, -1)
      : archiveName;
  if (
    !name ||
    name.startsWith("/") ||
    driveQualifiedPath.test(name) ||
    name !== name.normalize("NFC") ||
    hasControlCharacter(name) ||
    forbiddenCharacters.test(name)
  ) {
    throw new SourcePathError("Source path is not portable.");
  }
  if (Buffer.byteLength(name, "utf8") > limits.maximumPathBytes) {
    throw new SourcePathError("Source path exceeds its byte limit.");
  }

  const components = name.split("/");
  if (
    components.length > limits.maximumPathDepth ||
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        component.endsWith(".") ||
        component.endsWith(" ") ||
        reservedComponent.test(component) ||
        Buffer.byteLength(component, "utf8") > limits.maximumComponentBytes,
    )
  ) {
    throw new SourcePathError("Source path contains an invalid component.");
  }
  return components.join("/");
}

export class SourcePathRegistry {
  readonly #paths = new Map<string, RegisteredPath>();
  readonly #foldedPaths = new Map<string, string>();

  register(path: string, kind: PathKind): void {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      this.#register(components.slice(0, index).join("/"), "directory", false);
    }
    this.#register(path, kind, true);
    if (
      kind === "file" &&
      [...this.#paths.keys()].some((candidate) =>
        candidate.startsWith(`${path}/`),
      )
    ) {
      throw new SourcePathError(
        "A source file conflicts with an existing descendant.",
      );
    }
  }

  #register(path: string, kind: PathKind, explicit: boolean): void {
    const folded = path.normalize("NFKC").toLowerCase();
    const foldedOwner = this.#foldedPaths.get(folded);
    if (foldedOwner && foldedOwner !== path) {
      throw new SourcePathError("Source paths collide by case.");
    }

    const existing = this.#paths.get(path);
    if (existing) {
      if (existing.kind !== kind) {
        throw new SourcePathError(
          "Source path changes between file and directory.",
        );
      }
      if (explicit && existing.explicit) {
        throw new SourcePathError("Source archive contains a duplicate path.");
      }
      if (explicit) existing.explicit = true;
      return;
    }

    this.#paths.set(path, { kind, explicit });
    this.#foldedPaths.set(folded, path);
  }
}

export class SourcePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePathError";
  }
}
