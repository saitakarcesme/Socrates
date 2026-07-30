# Human Decision Override Plan

Status: Completed
Owner: Socrates core
Architecture decision: ADR-027

## Outcome

An operator can record an accountable final decision that differs from the
deterministic policy without hiding the automated result or bypassing hard
evidence constraints.

## Scope

- reject `kept` overrides for failed hard guardrails or invalid measurements
- preserve the automated decision and reason on every decision
- expose optional final-decision and reason fields before commitment
- keep the normal policy-only path concise
- render automated and final results separately after an override
- cover safe and forbidden overrides at the API boundary
- prove the override evidence in the browser journey

Decision editing, superseding decisions, approvals, and role-based permissions
remain out of scope.

## Acceptance

- an override requires a final decision and a non-empty reason
- a forbidden keep returns a domain error without writing a decision or event
- retrying the same experiment with a permitted final result succeeds
- the timeline status follows the final decision
- experiment evidence preserves the automated decision, policy reason, final
  decision, and override reason

## Verification

Verified on 2026-07-30 against PostgreSQL 17.10 and real Chromium. Domain tests
cover permitted and forbidden override classes. The API integration journey
proves that a failed hard guardrail cannot be overridden to `kept`, rolls back
without advancing the experiment, and can then commit a permitted final result.
The browser journey preserves an automated `kept` result beside an operator's
reasoned `discarded` result without horizontal overflow at 390 pixels.
