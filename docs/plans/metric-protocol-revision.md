# Metric Protocol Revision Plan

Status: Completed
Owner: Socrates core
Architecture decision: ADR-026

## Outcome

A user can create the next immutable metric protocol from the project screen
without changing the protocol of any existing run.

## Scope

- add the frozen metric definition to the run detail contract and projection
- use the run protocol throughout run and experiment screens
- add an explicit project-level revision form
- prefill the form from the current protocol
- allow guardrails to be added, edited, removed, and reordered by creation order
- preserve validation input and handle optimistic concurrency conflicts
- prove that an old run retains version N after the project advances to N+1
- prove that a new run captures version N+1

Metric history browsing, comparison views, deletion, and in-place editing are
out of scope. Definitions remain append-only.

## Delivery sequence

1. Extend the run detail read model and API contract with the frozen definition.
2. Replace project-current metric reads on run and experiment screens.
3. Add the revision form and explicit confirmation state.
4. Add API/read tests for the detail projection.
5. Extend the real-browser acceptance journey across a revision boundary.
6. Run format, type, lint, PostgreSQL integration, browser, and build gates.

## Acceptance

- a revision increments both project version and metric protocol version
- current project protocol changes only after a successful command
- an existing run continues to show and submit its original metric ID and unit
- a new run uses the revised protocol
- stale project versions refresh without silently replaying a changed payload
- no database type crosses into the web application

## Verification

Verified on 2026-07-30 against PostgreSQL 17.10 and real Chromium. The browser
journey completed an experiment on protocol v1, revised the project to v2,
confirmed the existing run still rendered v1, and created a new run on v2.
Project, revision, and run screens had no horizontal overflow at 390 pixels.
