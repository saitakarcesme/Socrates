# Phase 1 Web Manual Workflow

Status: Completed
Architecture decisions: ADR-022, ADR-024

## Outcome

Enable the existing command API through deliberate, state-aware forms while
keeping PostgreSQL and the Hono control plane authoritative.

## Delivery slices

1. Shared command form behavior
   - accessible field, error, pending, and success semantics
   - idempotency key retained for an unchanged retry payload
   - typed API errors translated without discarding input
2. Project creation
   - dedicated `/projects/new` route
   - name, objective, optional source, metric, threshold, noise, direction
   - navigate to the created project after validated success
3. Run setup
   - create run from a project using the current metric protocol
   - record baseline and start only in valid lifecycle states
4. Manual experiment lifecycle
   - propose, start, record before/after and guardrails, decide
   - create an evidence-linked learning after a decision
5. Timeline reconciliation
   - subscribe after the server snapshot
   - treat durable events as coalesced invalidation signals
   - reconnect from the highest observed sequence
6. Verification
   - form unit tests and API error behavior
   - clean PostgreSQL journey
   - keyboard, 390px, and desktop browser pass

## Form rules

- Native labels and inputs remain usable without a mouse.
- Decimal values stay strings through the browser and contract parser.
- Numeric budget counts are converted only after native constraint validation.
- The submit button communicates pending state and prevents concurrent sends.
- A user edit after a failed request changes the semantic payload and therefore
  rotates the next idempotency key.
- A transport failure retains the key so the same payload can be safely
  replayed.
- A successful mutation never mutates a local read model; navigation or
  `router.refresh()` obtains the committed projection.

## SSE rules

- The initial Server Component snapshot renders without JavaScript.
- EventSource begins after hydration and carries the last observed sequence in
  `after`.
- The event body is parsed only far enough to validate its durable sequence.
- Duplicate or older events are ignored.
- Multiple events arriving together cause one refresh.
- Connection errors are visible but do not erase the server snapshot.
- Component unmount closes EventSource and pending refresh timers.

## Exit gate

The manual project-to-learning journey operates without fake enabled controls,
duplicate command effects, locally invented research state, or fixture data.

Verified on 2026-07-30 with PostgreSQL 17.10 and an automated Chromium journey
at desktop and 390 × 844 viewports. The run timeline connected to durable SSE,
rendered the committed experiment, and had no horizontal overflow, framework
overlay, or browser console error.

The same critical path is retained as a Playwright acceptance test under
`apps/web/e2e`; CI runs it against the PostgreSQL service and real API/web
processes as specified by ADR-025.
