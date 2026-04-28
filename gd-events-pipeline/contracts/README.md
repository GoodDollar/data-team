# Onchain Contract Reference

Authoritative reference for every GoodDollar contract in scope, current and future. The pipeline reads addresses and ABIs from here (or from inline configs that mirror this). Block explorers verify deployment blocks.

---

## In MVP scope (XDC only)

### UBIScheme

Daily UBI distribution. Emits `UBIClaimed(address indexed claimer, uint256 amount)` plus 10 admin/lifecycle events (only `UBIClaimed` is ingested for MVP).

| Network | Address | Deployment block |
|---|---|---|
| XDC | `0x22867567e2d80f2049200e25c6f31cb6ec2f0faf` | 95,249,624 |

Source: `UBIScheme.sol` in the GoodDollar protocol repo.

### Invite Contract

Phase-3 invites campaign. Emits `InviteeJoined(address indexed inviter, address indexed invitee)` and `InviterBounty(address indexed inviter, address indexed invitee, uint256 bountyPaid, uint256 inviterLevel, bool earnedLevel)`.

| Network | Address | Deployment block |
|---|---|---|
| XDC | `0x6bd698566632bf2e81e2278f1656cb24aaf06d2e` | 95,144,756 |

The contract emits its own address as `inviter` for campaign signups (no human inviter). The L2 view detects this via `LOWER(inviter) = LOWER(contract_address)` — chain-agnostic, no hardcoded literals.

---

## Out of MVP scope (added post-validation)

### UBIScheme — Celo and Fuse deployments

| Network | Address |
|---|---|
| Celo | `0x43d72ff17701b2da814620735c39c620ce0ea4a1` |
| Fuse | `0xd253a5203817225e9768c05e5996d642fb96ba86` (note: HyperSync support unverified) |

### Invite Contract — Celo deployment

| Network | Address |
|---|---|
| Celo | `0x36829d1cda92fff5782d5d48991620664fc857d3` |

### Other GoodDollar contracts (post-MVP, multi-chain)

The full contract surface, captured for context. All addresses come from the GoodDollar protocol team / docs.

| Contract | Mainnet | Fuse | Celo | XDC |
|---|---|---|---|---|
| GoodDollar ERC20 | `0x67c5870b4a41d4ebef24d2456547a03f1f3e094b` | `0x495d133b938596c9984d462f007b676bdc57ecec` | `0x62b8b11039fcfe5ab0c56e502b1c372a3d2a9c7a` | `0xec2136843a983885aebf2feb3931f73a8ebee50c` |
| ContributionCalculation | `0x8eec64bb6807c0178f96277cce6a334b4e565e5c` | — | — | — |
| Identity | `0x76e76e10ac308a1d54a00f9df27edce4801f288b` | `0xfa8d865a962ca8456df331d78806152d3ac5b84f` | `0xc361a6e67822a0edc17d899227dd9fc50bd62f42` | `0x27a4a02c9ed591e1a86e2e5d05870292c34622c9` |
| OneTimePayments | — | `0xd9aa86e0ddb932bd78ab8c71c1b98f83cf610bd4` | `0xb27d247f5c2a61d2cb6b6e67fee51d839447e97d` | — |
| NameService | `0xec6dce387b1616a0c44ff2e4fa9e90e53cf14eb0` | `0xec6dce387b1616a0c44ff2e4fa9e90e53cf14eb0` | `0x0f5db7a64a6a64052693676ca898ec7f7a94ff4e` | `0x1e5154bf5e31ff56051bbd45958b879fb7a290fe` |
| Faucet | — | `0x01ab5966c1d742ae0cff7f14cc0f4d85156e83d9` | `0x4f93fa058b03953c851efaa2e4fc5c34afdfab84` | `0x7344da1be296f03fbb8082adac5696058b5a9bd9` |
| MentoReserve | — | — | `0x94a3240f484a04f5e3d524f528d02694c109463b` | `0x94a3240f484a04f5e3d524f528d02694c109463b` |
| MentoExpansionController | — | — | `0x94a3240f484a04f5e3d524f528d02694c109463b` | `0x94a3240f484a04f5e3d524f528d02694c109463b` |
| MentoExchangeProvider | — | — | `0x94a3240f484a04f5e3d524f528d02694c109463b` | `0x94a3240f484a04f5e3d524f528d02694c109463b` |
| MentoBroker | — | — | `0x94a3240f484a04f5e3d524f528d02694c109463b` | `0x94a3240f484a04f5e3d524f528d02694c109463b` |
| MessagePassingBridge | `0xa3247276dbcc76dd7705273f766eb3e8a5ecf4a5` | same | same | same |
| DAO Controller | `0x95c0d9dcea1e243ed696f34cac5e6559c3c128a3` | `0xbce053b99e22158f8b62f4dbfbede1f936b2d4e4` | `0x0be7c592374ee0bd0ccbfc76be758a138bcaec6e` | `0x75a8be0c2deaded8fc9eceb5f01ad0b979b7ad03` |
| DAO Avatar | `0x1ecfd1afb601c406ff0e13c3485f2d75699b6817` | `0xf96dadc6d71113f6500e97590760c924da1ef70e` | `0x495d133b938596c9984d462f007b676bdc57ecec` | `0x21eac3fe218307bee0463f77ebca3b50f452c0ce` |

> "—" = not deployed on that chain. "same" = same address as Mainnet.

---

## ABIs

`./ABIs/` holds JSON ABI files for each contract. For MVP only the events portions are needed; the pipeline already has them inline. ABI files in this folder become the canonical source as the contract surface expands.

### Current contents

| File | Contract |
|---|---|
| `XDC contracts ABI.csv` | Provided by user — XDC contract ABIs in CSV form |

### Files expected post-MVP

| File | Contract | Source |
|---|---|---|
| `UBIScheme.json` | UBIScheme | <https://github.com/GoodDollar/GoodProtocol> → `contracts/UBIScheme.sol` |
| `InviteContract.json` | Invite contract | same repo |
| `Identity.json` | Identity | same repo |
| `Faucet.json` | Faucet | same repo |
| `MessagePassingBridge.json` | MPB | same repo |

To add a new ABI file: paste the JSON exactly as exported from `solc` / hardhat / forge into `./ABIs/<ContractName>.json`. Filename should match the Solidity contract name.
