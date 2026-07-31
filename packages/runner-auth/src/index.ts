import {
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from "node:crypto";

import { runnerBearerTokenSchema } from "@socrates/contracts";

const secretBytes = 32;
const encodedSecretLength = 43;
const dummyDigest = Buffer.alloc(32);

export type RunnerPrincipal = {
  tokenId: string;
  runnerId: string;
  workspaceId: string;
};

export type RunnerCredentialCandidate = RunnerPrincipal & {
  secretDigest: string;
  usable: boolean;
};

export interface RunnerCredentialLookup {
  findCandidate(tokenId: string): Promise<RunnerCredentialCandidate | null>;
}

export interface RunnerAuthenticator {
  authenticate(credential: string): Promise<RunnerPrincipal | null>;
}

export type GeneratedRunnerCredential = {
  tokenId: string;
  credential: string;
  secretDigest: string;
};

function digest(secret: Uint8Array): Buffer {
  return createHash("sha256").update(secret).digest();
}

function parseCredential(
  credential: string,
): { tokenId: string; secret: Buffer } | null {
  if (!runnerBearerTokenSchema.safeParse(credential).success) return null;
  const [, tokenId, encodedSecret] = credential.split(".");
  if (
    !tokenId ||
    !encodedSecret ||
    encodedSecret.length !== encodedSecretLength
  ) {
    return null;
  }

  const secret = Buffer.from(encodedSecret, "base64url");
  if (
    secret.byteLength !== secretBytes ||
    secret.toString("base64url") !== encodedSecret
  ) {
    return null;
  }
  return { tokenId, secret };
}

function storedDigest(value: string | undefined): Buffer {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return dummyDigest;
  const decoded = Buffer.from(value, "hex");
  return decoded.byteLength === dummyDigest.byteLength ? decoded : dummyDigest;
}

export function generateRunnerCredential(
  options: {
    randomBytes?: (size: number) => Buffer;
    randomUUID?: () => string;
  } = {},
): GeneratedRunnerCredential {
  const tokenId = (options.randomUUID ?? nodeRandomUUID)();
  const secret = (options.randomBytes ?? nodeRandomBytes)(secretBytes);
  if (secret.byteLength !== secretBytes) {
    throw new Error(
      "Runner credential entropy source returned the wrong size.",
    );
  }
  const encodedSecret = secret.toString("base64url");
  const credential = runnerBearerTokenSchema.parse(
    `srt1.${tokenId}.${encodedSecret}`,
  );

  return {
    tokenId,
    credential,
    secretDigest: digest(secret).toString("hex"),
  };
}

export class OpaqueRunnerAuthenticator implements RunnerAuthenticator {
  constructor(private readonly credentials: RunnerCredentialLookup) {}

  async authenticate(credential: string): Promise<RunnerPrincipal | null> {
    const parsed = parseCredential(credential);
    if (!parsed) return null;

    const candidate = await this.credentials.findCandidate(parsed.tokenId);
    const suppliedDigest = digest(parsed.secret);
    const accepted = timingSafeEqual(
      suppliedDigest,
      storedDigest(candidate?.secretDigest),
    );
    if (!candidate || !candidate.usable || !accepted) return null;

    return {
      tokenId: candidate.tokenId,
      runnerId: candidate.runnerId,
      workspaceId: candidate.workspaceId,
    };
  }
}
