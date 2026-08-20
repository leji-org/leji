# Governance

Leji is an open specification. Its goal is to be an open, vendor-agnostic standard for the shared context layer of AI-native teams. This document says who maintains it, how it changes, and the commitments that keep conformance independent of any product built on it.

## Stewardship

Leji was created by Vuong Nguyen. Contexing, LLC is the steward: it maintains the specification, the schemas, the reference tooling, and this repository, and it reviews proposals. Contexing also builds and sells commercial products on Leji; the independence commitments below are what keep the standard independent of those products.

The steward role exists to keep the standard coherent, not to control who uses it. What protects adopters is not trust in the steward's intentions: the complete specification and tooling are openly licensed, run without any steward service, require no steward endpoint, permit competing implementations and commercial services, and can be forked.

## Independence commitments

These commitments are checkable in public, and they are what keep conformance independent of any product, including the steward's own.

- **No commercial gate.** Conformance never requires a commercial product or service. Everything needed to build, validate, and conform to a context layer is in this repository under open licenses.
- **No required endpoint.** Mounts and federation resolve against any origin the adopter names. No part of the specification requires, defaults to, or privileges an endpoint operated by the steward.
- **No privileged conformance implementation.** The first-party SDKs and CLI are Leji's primary reference tooling and default adoption path. They are maintained here and tested against the shared fixtures. Conformance is determined by the specification, schemas, and public conformance checklist, not by using those tools. An independent conformant implementation is a valid implementation of Leji.
- **No conformance advantage.** The steward will not shape the specification, schemas, conformance levels, or governance process to require or favor its own products or services over independent implementations. The steward may build, promote, and sell first-party tooling and services, but Leji conformance is judged by the spec and conformance checklist, not by who built the tool.
- **Self-attestation, no authority.** A team claims its conformance level in its own manifest, and tools can check every requirement a machine can check and report the rest, which the team stands behind. There is no certification program, registry, gatekeeper, or fee. See [spec/conformance.md](spec/conformance.md).
- **Spec issues are filed publicly.** Problems with the specification, schemas, or fixtures that the steward finds while building its commercial products are filed as public issues in `leji-org`, never in a private tracker. Responsibly embargoed security reports and legally restricted matters are the one exception, and they are filed publicly once the constraint lifts.
- **Information parity.** Conformance questions, fixture changes, and spec decisions happen in public. The steward's commercial products get no private interpretation channel, no early access to spec decisions, and no release-timing advantage: no spec decision or interpretation is relied on by a steward product before it is public. An independent implementer, including a direct competitor, works from the same public record.

## Assets and succession

The steward holds the operated assets the specification depends on. These transfer with maintainership:

- the domains `leji.org`, `leji.dev`, `leji.io`, and `leji.to`
- the Leji name and logo
- the `leji-org` GitHub organization
- `security@leji.org`

The commitments in this document travel with those assets: any successor steward, including an acquirer of the name, inherits them as the project's governing policy. What makes them stick is not this document alone. The specification, the schemas, and the reference tooling are already licensed to everyone, and anyone may fork them, so a successor that abandoned these commitments would be leaving the project rather than taking it.

The steward's commercial product assets are held separately and do not transfer with maintainership of the specification. A successor steward receives the specification, the name, and the canonical addresses above without them.

## Independent implementations

You may implement Leji in any language or tool. Building on the schemas and SDK is covered by Apache-2.0, including its patent grant; quoting, translating, and adapting the specification is covered by CC-BY-4.0 with attribution. See [LICENSE.md](LICENSE.md). No implementation needs the steward's permission or blessing.

## The Leji name

The specification and code are open; the name is how people find the real thing. You may state that a tool "supports Leji" or "conforms to Leji 1.0" when it does. Please don't use the name in a way that implies official endorsement, or that presents a fork or derivative as the canonical Leji. Honest "conforms to" and "compatible with" claims are always fine.

You may build, sell, and promote independent commercial products and services that implement Leji, including products competing directly with the steward's. No permission, license, or notification is required.

Full terms, including what a fork may call its binary and what the logo requires: [the trademark and usage policy](https://leji.org/trademark/).

## How the specification changes

Changes happen by proposal, in the open:

1. Open an issue describing the problem and the intent behind the change, not just a fix.
2. Propose the change as a pull request against `spec/`, and the schemas where the machine-readable surface is affected.
3. Normative changes carry a changelog entry and a version bump under the spec's own [versioning rules](spec/versioning.md).

Decisions are recorded where the discussion happened, in the issue or pull request, and in a decision record when the change is architectural. A proposal the steward declines remains publicly documented with the reasoning recorded; it may be closed as declined rather than removed or quietly buried. One narrow exception, stated in advance: a matter under security embargo or legal constraint is recorded with its reasoning once the constraint lifts.

## Steward proposals and conflicts of interest

The steward also builds commercial products on Leji, so some of its own proposals touch areas those products depend on. Those proposals are labeled and slowed down, publicly:

- A steward-authored proposal touching an area a steward product depends on is labeled `steward-proposal` on the issue and the pull request, and says which product interest it touches.
- The ordinary comment period for a normative proposal is 14 days. A labeled steward proposal stays open for 28 days instead, and is not merged before that period ends.
- The label and the dates are visible in public history, which is what makes "no conformance advantage" checkable rather than asserted.

## Decision-making, today and later

Contexing is the steward and final decision-maker, on the record. The steward may broaden governance to a named multi-party maintainer group as contributor capacity warrants. Any such change preserves the open licenses, the public process, and the independence commitments above. The Leji name remains with the steward.
