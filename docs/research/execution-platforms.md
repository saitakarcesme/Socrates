# Execution platform research

Status: Reviewed for Phase 2 planning

Reviewed: 2026-07-31

## Question

Which lessons from current autoresearch and coding-agent systems should shape
Socrates' first execution plane without prematurely building an autonomous
research loop?

## Primary sources

### Karpathy autoresearch

Source: <https://github.com/karpathy/autoresearch>

The reference loop deliberately narrows the editable surface, uses a fixed
training window, measures one explicit result, keeps or discards the change,
and writes an experiment log before repeating. Its strength is protocol
discipline, not general-purpose orchestration.

Socrates retains:

- an immutable baseline and metric protocol
- a bounded experiment budget
- a small, declared action surface
- an explicit keep/discard result
- accumulated experiment knowledge

Socrates does not copy:

- repository files as the durable database
- an indefinitely running interactive agent session
- one mutable working tree as both source and experiment history
- implicit trust in the host execution environment

### Sakana AI Scientist v2

Source: <https://github.com/SakanaAI/AI-Scientist-v2>

AI Scientist v2 separates ideation from the experiment pipeline and uses
multiple workers in a best-first tree search. The system demonstrates why
parent-child experiment relationships and parallel-ready contracts matter even
when the first UI is a linear timeline.

Socrates defers ideation, tree search, and parallel scheduling to later phases.
Phase 2 only preserves the identifiers and task boundaries those strategies
will need.

### SWE-ReX

Source: <https://github.com/SWE-agent/swe-rex>

SWE-ReX puts shell environments behind a common runtime interface and supports
local containers and remote backends without coupling agent logic to either.
This validates a stable execution contract whose adapters can change
independently.

Socrates adopts the boundary, not the implementation. The runner protocol is a
Socrates-owned, versioned contract and remains independent of any one sandbox
vendor.

### OpenHands Runtime

Sources:

- <https://docs.openhands.dev/openhands/usage/architecture/runtime>
- <https://docs.openhands.dev/overview/faqs>

OpenHands documents a client-server runtime inside disposable Docker
environments, reproducible image tagging, and copy-on-write workspace options.
Its safety guidance also makes the residual risks concrete: network access,
credentials, and writable host mounts can escape the intended product boundary
even when commands run in a container.

Socrates therefore treats isolation, network, mounts, credentials, resource
limits, and cleanup as separate policies. "Runs in Docker" is not an acceptance
criterion by itself.

## Resulting product position

Socrates is not a generic remote shell and is not an agent chat with a terminal.
Its execution plane exists to produce attributable evidence for a declared
experiment:

```text
frozen source + declared action + frozen metric + hard limits
  -> isolated attempt
  -> ordered logs, measurements, artifacts, and terminal outcome
  -> deterministic control-plane decision
```

The operator can inspect every boundary in that chain. A future research
strategy may propose tasks, but it receives no special execution privileges.

## Design consequences

1. Control-plane records are authoritative; runner local state is recoverable.
2. A task and each retry attempt have different identities.
3. Lease fencing is required before distributed execution, even for the first
   local runner.
4. Capabilities are structured data, not free-form labels.
5. OCI isolation is the minimum executable backend; host shell is unsupported.
6. Network starts disabled and credentials start absent.
7. Logs and artifacts are untrusted, bounded evidence.
8. The fake runner proves scheduling semantics before a real command can run.
9. Phase 2 ends at measured execution. Autonomous iteration begins in Phase 3.

## Deferred investigations

- Select and threat-model the concrete OCI engine after a local spike.
- Benchmark cold-start and copy-on-write workspace strategies.
- Choose the artifact-store production adapter.
- Define egress proxy and destination policy semantics.
- Define multi-tenant runner authentication after the authentication architecture
  exists.
- Evaluate stronger isolation such as microVMs for cloud runners in Phase 4.
