# Release scope: which chains this system covers

**This release covers Celo, XDC and Ethereum. Fuse is out.**

That one sentence is the whole decision. The rest of this page explains what it means for the
data you can query, and how the codebase enforces it so the statement cannot drift out of date
without something failing.

| Chain | In the release | Ingested in this release | Note |
| - | - | - | - |
| Celo | Yes | Yes | Primary chain for claims |
| XDC | Yes | Yes | Holds the existing invites and claims dataset |
| Ethereum | Yes | No | Declared, deliberately not ingested here. Reserve paused since 2023-12-17, and no model reads an Ethereum contract today |
| **Fuse** | **No, dropped 2026-09-28** | No | See below |
| Base | No | No | Never assessed. Recorded as a decision not to look, rather than as a finding that there is nothing there |
| Gnosis | No | No | Same as Base |

"In the release" and "ingested" are different questions and this table keeps them apart. A chain
can be declared in scope and still not be captured yet; Ethereum is exactly that case.

## Why Fuse was dropped, 2026-09-28

Fuse data is disproportionately expensive to obtain, and the cost was holding up everything else.
Specifically:

- There is no HyperSync index for Fuse, so it is the only chain that needs a raw RPC adapter.
- The one archive-capable Fuse endpoint this project could find is rate limited to roughly 54
  reads per hour, and both enumerating readers cap at 20,000 logs per response.
- Fuse prunes its transaction index, so a receipt lookup cannot establish a contract's creation
  block there the way it can elsewhere.
- Finality cannot be read from any Fuse endpoint, so every Fuse row would have to carry a weaker
  assurance than the same row on any other chain.

None of that is a statement about whether Fuse matters. It is a statement about what it costs to
serve it to the same standard as the rest, and the decision was to ship the rest first.

**Fuse can be added back as its own piece of work.** Nothing has been thrown away: Fuse history is
permanently readable from the chain itself, and the inventory this project already measured is
still in the repository (see the next section). Bringing it back means building the RPC reader and
re-running ingestion, not rediscovering what is there.

## What "dropped" means for data that is already recorded

**The Fuse inventory stays in the repository. It is a record, not a re-admission.**

The reference seeds still carry every Fuse row this project measured: 1 chain row, 96 contract
deployment rows and 616 event surface rows. They are kept for three reasons:

1. They cost real measurement, and deleting them means paying for it twice.
2. The event surface rows are bound to the deployment rows by a foreign key that the test suite
   checks. Deleting the deployment rows would orphan 616 surface rows and turn a passing test into
   616 failures, which is a worse outcome than describing the situation accurately.
3. A deleted row says nothing. A retained row that is declared out of the release says exactly
   what happened and when.

Retaining the rows does **not** put Fuse back in the release. The pipeline refuses to build
capture targets for a chain outside the release scope, the planner reports such a chain as
unsupported and exits nonzero, and no model above the raw layer may consume an era on a chain that
is not in release. Those three refusals are what make the table at the top of this page true in
the running system and not only on this page.

## How this is enforced

The declaration lives in code, next to the loader that reads the reference seeds:
`pipeline-v5/src/control-plane/releaseScope.ts`, in `RELEASE_SCOPE_FREEZE`.

- `releaseChains` is the list in the table above. Every other part of the system reads the chain
  list from there rather than keeping a copy, so changing it changes the whole system at once.
- `chainsDropped` records a chain that was deliberately removed, with the date and the reason.
  That field is what separates "we decided to drop this" from "nobody ever decided about this".
  A chain that is in neither list still fails the build, which is the case worth catching: a chain
  arriving in a seed that no one has made a decision about.
- A retained row on a dropped chain may not declare itself in release. That combination is
  refused, so the inventory cannot quietly become a re-admission through a seed edit.

## Changing it

Scope is frozen. Changing which chains are in the release is a deliberate act, not a seed edit:
amend `RELEASE_SCOPE_FREEZE`, amend this page, and re-derive anything that was built on the old
scope. The checks above exist so that doing it by accident is not possible.
