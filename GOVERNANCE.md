# Governance

Leji is an open specification. Its goal is to be a neutral, vendor-agnostic standard for the shared context layer of AI-native teams. This document says who maintains it, how it changes, and the commitments that keep it neutral.

## Stewardship

Leji was created by Vuong Nguyen. Meteor Dreams, LLC is the current steward: it maintains the specification, the schemas, the reference tooling, and this repository, and it reviews proposals.

The steward role exists to keep the standard coherent, not to control who uses it. It is designed to be transferable to a neutral foundation or a multi-party maintainer group as adoption warrants. The permissive licenses and this document exist so that such a transfer changes nothing for adopters.

## Neutrality commitments

These are the commitments that make "neutral standard" more than a label:

- **No commercial gate.** Conformance never requires a commercial product or service. Everything needed to build, validate, and conform to a context layer is in this repository under open licenses.
- **No privileged conformance implementation.** The first-party SDKs and CLI are Leji's primary reference tooling and default adoption path. They are maintained here and tested against the shared fixtures. Conformance is determined by the specification, schemas, and public conformance checklist, not by using those tools. An independent conformant implementation is valid Leji.
- **No conformance advantage.** The steward will not shape the specification, schemas, conformance levels, or governance process to require or favor its own products or services over independent implementations. The steward may build, promote, and sell first-party tooling and services, but Leji conformance is judged by the spec and conformance checklist, not by who built the tool.
- **Self-attestation, no authority.** A team claims its conformance level in its own manifest, and any conformant tool can check the claim. There is no certification program, registry, gatekeeper, or fee. See [spec/conformance.md](spec/conformance.md).

## Independent implementations

You may implement Leji in any language or tool. Building on the schemas and SDK is covered by Apache-2.0, including its patent grant; quoting, translating, and adapting the specification is covered by CC-BY-4.0 with attribution. See [LICENSE.md](LICENSE.md). No implementation needs the steward's permission or blessing.

## The Leji name

The specification and code are open; the name is how people find the real thing. You may state that a tool "supports Leji" or "conforms to Leji 1.0" when it does. Please don't use the name in a way that implies official endorsement, or that presents a fork or derivative as the canonical Leji. Honest "conforms to" and "compatible with" claims are always fine.

## How the specification changes

Changes happen by proposal, in the open:

1. Open an issue describing the problem and the intent behind the change, not just a fix.
2. Propose the change as a pull request against `spec/`, and the schemas where the machine-readable surface is affected.
3. Normative changes carry a changelog entry and a version bump under the spec's own [versioning rules](spec/versioning.md).

Decisions are recorded where the discussion happened, in the issue or pull request, and in a decision record when the change is architectural. A proposal the steward declines remains publicly documented with the reasoning recorded; it may be closed as declined rather than removed or quietly buried.

## Decision-making, today and later

Today Meteor Dreams is the steward and the final decision-maker, on the record. The steward intends to broaden governance as adoption and contributor capacity warrant, potentially through a neutral foundation or a named multi-party maintainer group. Any such transition should preserve the open licenses, the public process, and the conformance neutrality described here.
