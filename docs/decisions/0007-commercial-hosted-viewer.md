---
id: commercial-hosted-viewer
title: Commercial hosted viewer and governance language change
status: accepted
date: 2026-08-08
deciders:
  - Vuong Nguyen
affectedPaths:
  - GOVERNANCE.md
  - README.md
  - LICENSE.md
  - SECURITY.md
  - CONTRIBUTING.md
  - packages/site/
affectedCategories:
  - governance
  - decisions
links:
  - 0004-declare-spec-1-0-ga.md
---

# Commercial hosted viewer and governance language change

## Context

Early adopters are teams introduced through consulting engagements, and adoption stalls at the same point each time. The context layer works for engineers running `leji view` locally, but product managers, designers, support, and compliance staff have no git seat and no terminal. Teams asked for a hosted viewer their whole organization could reach. Their alternative was placing a static build behind a firewall or VPN, which grants everyone inside identical access, provides no per-person audit trail, and adds operational burden they explicitly did not want to take on.

Authentication, per-person access control, and hosted operations are infrastructure, not format. Building them into the specification would violate the no-required-endpoint commitment and turn a document format into a service dependency. The reference tooling remains local-first and account-free; the user-invoked federation fetches are the recorded exception.

## Decision

Contexing, LLC, Leji's steward, is developing LejiAI, a commercial hosted viewer at leji.ai. The specification, schemas, SDKs, CLI, and fixtures remain permissively licensed and fully capable without it. Conformance remains self-attested and free. Competing implementations, including commercial hosted viewers, remain welcome and need no permission.

## Governance language change

The Trust page as published at the 1.3.0 GA (2026-07-30) stated an intent to move toward neutral, multi-party governance as adoption grows. That intent assumed no commercial product would carry the Leji name. This record dates from days after GA, before any distribution push and before any external adoption. With a hosted viewer being built at leji.ai, full assignment to a foundation is no longer a promise the steward can keep, so the language now states the durable version: a named steward, a forkable specification, and the name remaining with the steward. Broadening to a named multi-party maintainer group remains open, and `GOVERNANCE.md` says so.

The same commit series adds the commitments that make the arrangement checkable: no required endpoint, public filing of spec issues found during commercial product work, information parity, and a labeled comment period for steward proposals that touch product territory.

## Consequences

The specification has no adoption path into mixed teams without hosted access, and hosted access needs a sustainable operator. Funding stewardship through an optional product, with the free path complete and the commercial boundary written down, was judged more honest than maintaining a governance promise the product forecloses.

The cost lands on the steward. Every one of those commitments is publicly checkable, and a proposal that quietly favors the product is now a visible break with a written record rather than a matter of interpretation.
