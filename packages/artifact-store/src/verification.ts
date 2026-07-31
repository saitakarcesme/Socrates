const verifiedArtifacts = new WeakSet<object>();

export type VerifiedArtifact = Readonly<{
  digest: string;
  sizeBytes: number;
}>;

export function issueVerifiedArtifact(
  digest: string,
  sizeBytes: number,
): VerifiedArtifact {
  const artifact = Object.freeze({ digest, sizeBytes });
  verifiedArtifacts.add(artifact);
  return artifact;
}

export function isVerifiedArtifact(
  value: VerifiedArtifact | undefined,
): value is VerifiedArtifact {
  return value !== undefined && verifiedArtifacts.has(value);
}
