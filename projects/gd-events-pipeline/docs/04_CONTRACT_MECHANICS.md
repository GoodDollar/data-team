# GoodDollar Invite Contract — How It Works

A plain-language guide to the invite contract mechanics, the blockchain events it emits, and
why the warehouse transforms the data the way it does.

Read this before touching `warehouse/L2/03_invite_payouts.sql` or any mart that involves
invite bounty amounts.

---

## 1. The Invite Program at a Glance

GoodDollar runs a referral campaign where existing users ("inviters") share a personal invite
code with someone new ("invitees"). When the invitee completes the requirements, both parties
receive a G$ bounty. This creates a double-sided incentive: inviters are motivated to recruit,
and invitees receive a welcome gift that rewards them for completing the onboarding steps.

Two flavors exist:

| Flavor | What triggers it | Who gets paid |
|---|---|---|
| **Referral** | Invitee uses a human inviter's personal code | Both the invitee (G$500) and the inviter (amount varies by level) |
| **Campaign** | Invitee uses the general campaign code | Only the invitee (G$500); no individual inviter |

---

## 2. The Two Participants

### Invitee
The new user. Always receives **G$500** upon completing the requirements, regardless of which
code they used or who invited them. This amount is fixed by the invite contract at deployment
and is the same for everyone.

### Inviter (referral only)
The existing user who shared their personal code. Receives a bounty whose size depends on
their **level** — how many successful conversions they have made before this one. A level-0
inviter earns G$1000. Higher levels earn progressively more (the amounts are configured in
the contract by the protocol admin).

For campaign signups there is no individual inviter and no inviter bounty.

---

## 3. What Actually Happens on the Blockchain

Here is a complete walkthrough of a referral invite, following the chain events from start
to finish.

### Step 1 — The invitee joins

Alice shares her personal invite link with Bob. Bob creates his GoodDollar wallet using that
link. At that moment the invite contract fires the first event:

```
InviteeJoined(
  inviter = Alice's wallet address,
  invitee = Bob's wallet address
)
```

This is recorded in our warehouse as a row in `Semantic.invite_signups` with
`signup_type = 'referral'`.

### Step 2 — Bob completes the requirements

Bob claims his daily UBI for several days. Each claim fires a `UBIClaimed` event on the UBI
contract. The invite contract tracks Bob's accumulated claim count via its `daysClaimed`
counter (part of the `levels` struct). The documented threshold is **3 UBI claims**. Nothing
fires yet from the invite contract's side.

### Step 3 — The payout is triggered

Once Bob has met the requirements (3 UBI claims tracked by the contract's `daysClaimed`
counter), someone — Bob himself, a relayer, or an automated process — calls `collectBounty`
on the invite contract. In the same transaction, three things happen:

1. The invite contract transfers **G$1000 from its own token balance to Alice's wallet**.
   This emits a GoodDollar ERC20 `Transfer(from=invite_contract, to=Alice, value=G$1000)`
   event on the GoodDollar token contract.
2. The invite contract transfers **G$500 from its own token balance to Bob's wallet**.
   This emits a GoodDollar ERC20 `Transfer(from=invite_contract, to=Bob, value=G$500)`
   event on the GoodDollar token contract.
3. The invite contract fires its own event:

```
InviterBounty(
  inviter      = Alice's address,
  invitee      = Bob's address,
  bountyPaid   = 1000000000000000000000,   ← Alice's bounty in raw token units
  inviterLevel = 0,
  earnedLevel  = false
)
```

This event is recorded in `Semantic.invite_payouts`.

---

## 4. The Key Non-Obvious Thing: The Invitee's Payment Doesn't Appear in the Invite Contract Event

The `InviterBounty` event records only the **inviter's** payment. The invitee's payment of
G$500 happens in the same transaction as a GoodDollar ERC20 token transfer, emitted by the
GoodDollar token contract — not the invite contract.

This is not a bug. It is intentional contract design. The contract name, `InviterBounty`,
says exactly what it does: it announces the inviter's reward. The invitee's transfer is a
standard ERC20 transfer with no dedicated invite-contract event wrapping it.

**Why you see both on a block explorer:** Block explorers (e.g. xdcscan) show *all* events
from *all* contracts involved in a transaction. When `collectBounty` fires, two GoodDollar
`Transfer` events appear in the logs — one for G$1000 to the inviter, one for G$500 to the
invitee — plus the `InviterBounty` event from the invite contract. The explorer renders all
three under the same transaction.

**Why our warehouse only sees G$1000 in the event field:** Our pipeline ingests events
emitted by the invite contract only. The two GoodDollar `Transfer` events come from the
GoodDollar token contract and are not in `InviteContractEvents`. So `bountyPaid` in
`InviterBounty` = the inviter's G$1000 only.

**Verified on-chain:** Transaction `0xa295a058b8234f8eac6681be80528812b02382e2d95d21f762c8aa7950411394`
is in our L1 table with `bounty_paid = 1000000000000000000000` (= G$1000). The same
transaction on xdcscan shows two separate G$ transfers: G$1000 to the inviter and G$500 to
the invitee.

**What this means for the warehouse:**
- `bountyPaid` in the event = the inviter's amount only (G$1000 at level 0).
- The invitee's G$500 has no event field to read. It is the `_level0Bounty` parameter from
  the invite contract's deployment — a stable, documented protocol constant.
- `total_amount_g` per payout = inviter amount (chain-derived) + G$500 (constant). For a
  level-0 referral payout: G$1000 + G$500 = G$1500.

If the protocol ever changes the invitee bounty, see the **Maintenance** section.

---

## 5. Raw Token Amounts and the 10¹⁸ Factor

When you look at `bounty_paid` directly from the blockchain, you see something like:

```
1000000000000000000000
```

This looks like a trillion. It is actually G$1000.

**Why?** The GoodDollar token (G$) stores balances as whole integers internally — there are
no decimal points on the blockchain. The contract multiplies every face-value amount by
10¹⁸ before storing or emitting it. To recover the face value, divide by 10¹⁸.

```
raw amount:   1000000000000000000000
divide by:    1000000000000000000    (= 10¹⁸)
face value:   1000                  (= G$1000)
```

This 18-decimal convention is standard for ERC20 tokens. The G$ token has 18 decimal places,
meaning the smallest representable unit is 0.000000000000000001 G$.

**A quick contrast** — the UBI Claim contract works differently:

```
UBIClaimed.amount (raw):  500
divide by:                100    (= 10²)
face value:               5      (= G$5)
```

The UBIScheme contract uses only 2 decimal places. Same token, different contract, different
precision choice by the protocol designers. This is why `warehouse/L2/04_claim_events.sql`
divides by 100 while `warehouse/L2/03_invite_payouts.sql` divides by 10¹⁸.

> **Quick rule of thumb:** if a raw amount ends in 18+ zeros, it came from an 18-decimal
> contract. If it ends in 2 zeros (or just looks like a small integer), it's likely a
> 2-decimal contract.

---

## 6. Campaign Payouts vs Referral Payouts

The invite contract uses a sentinel value in the `inviter` field to signal whether a payout
is from a personal referral or the general campaign:

| `inviter` value in the event | Meaning |
|---|---|
| Another user's wallet address | **Referral** — a human inviter gets a bounty |
| The invite contract's own address | **Campaign** — no individual inviter; invitee only |
| The zero address (`0x0000...0000`) | **No code** — user joined to become an inviter, not as a referred user |

The warehouse uses a `CASE` statement in `invite_signups.sql` and `invite_payouts.sql` to
classify rows — comparing `LOWER(inviter)` to `LOWER(contract_address)` rather than to a
hardcoded address, so it works the same way regardless of which chain the contract is on.

For campaign payouts in `invite_payouts`:
- `inviter_address` → NULL (no human inviter)
- `inviter_amount_g` → NULL (no payment)
- `total_amount_g` → G$500 (invitee only)

---

## 7. The Inviter Level System

The contract supports a multi-tier level system: inviters earn levels as they accumulate
successful conversions, and higher levels earn a larger G$ bounty per referral. The level
at payout time is recorded in the `inviterLevel` field of the `InviterBounty` event and
stored in the warehouse as `inviter_level`.

**Current deployment status:** The level system is deployed in the contract but levels 1+
have not been activated. All 284 payouts in the current dataset are at `inviter_level = 0`
(G$1000 per referral). Level advancement is not expected to be used in the near term.

The bounty amounts per level are stored in the contract's `levels` state variable and are
configurable by the protocol admin via `setLevel()`. The warehouse reads the inviter's
payout directly from `bountyPaid` rather than hardcoding amounts per level — so if levels
are ever activated and higher-level payouts appear in the data, the warehouse will
automatically reflect the correct amounts. No SQL update required.

---

## 8. The Two On-Chain Events, Summarized

### `InviteeJoined(inviter, invitee)`

| Field | Type | What it means |
|---|---|---|
| `inviter` | address | Who recruited this user (or sentinel value — see §6) |
| `invitee` | address | The new user who just joined |

**Fires when:** the invitee creates their wallet using an invite code.
**Does NOT mean:** the invitee has been paid. Payment comes later, via `InviterBounty`.

**Warehouse landing zone:** `Semantic.invite_signups`

---

### `InviterBounty(inviter, invitee, bountyPaid, inviterLevel, earnedLevel)`

| Field | Type | What it means |
|---|---|---|
| `inviter` | address | The inviter receiving the bounty (or contract address for campaign) |
| `invitee` | address | The invitee whose completion triggered this payout |
| `bountyPaid` | uint256 | **Inviter's** bounty in raw 18-decimal token units |
| `inviterLevel` | uint256 | The inviter's tier at payout time |
| `earnedLevel` | bool | Whether this payout pushed the inviter to the next level |

**Fires when:** the invitee meets the requirements and `collectBounty` is called.
**Note:** the invitee's G$500 payment is made in the same transaction but is **not** in this
event. `bountyPaid` covers the inviter's portion only.

**Warehouse landing zone:** `Semantic.invite_payouts`

---

## 9. Warehouse Transformation Cheat Sheet

A summary of how L1 raw values become the G$ amounts you see in dashboards:

| Raw event field | Raw value example | Transformation | Warehouse column | Result |
|---|---|---|---|---|
| `bountyPaid` (inviter's portion) | `1000000000000000000000` | `÷ 10¹⁸` | `inviter_amount_g` | G$1000 |
| *(no event field for invitee)* | *(absent from event)* | protocol constant | `invitee_amount_g` | G$500 |
| *(sum of above)* | — | `inviter_amount_g + invitee_amount_g` | `total_amount_g` | G$1500 (referral) / G$500 (campaign) |
| `amount` (UBI claim) | `500` | `÷ 100` | `amount_g` (claim_events) | G$5 |

---

## 10. Frequently Asked Questions

**Q: Why is `invitee_amount_g` always G$500? Can't it change?**

It can, but only if the protocol admin calls `setLevel(0, ...)` on the invite contract, or
deploys a new contract with a different `_level0Bounty` parameter. This would be a deliberate
protocol governance decision, not an automatic market change. If it happens:
1. Historical rows (already in the warehouse) would still show G$500 — they reflect what was
   paid at the time.
2. Future rows would need the constant updated. See the Maintenance section below.

---

**Q: Why does `total_g_spent` reconcile exactly with `total_g_to_invitees + total_g_to_inviters`?**

Because the formula is consistent: for every referral payout we count G$500 (invitee) + the
chain-derived inviter amount. For every campaign payout we count G$500 only. Both sides of the
reconciliation use the same arithmetic. If they ever diverge, it means either a new payout type
appeared that isn't classified, or `invitee_amount_g` changed.

---

**Q: Why are `InviteeJoined` and `InviterBounty` separate events instead of one?**

Because they happen at different times. A user joins the moment they scan the QR code (step 1).
The bounty is only paid after the invitee accumulates **3 UBI claims** — days or weeks later
(step 3). The contract tracks this via its `daysClaimed` counter in the `levels` struct. Two
events for two distinct moments. This also means not every `InviteeJoined` row has a matching
`InviterBounty` row — many signups never convert to payouts.

---

**Q: Why do UBI claims use `/ 100` but invite payouts use `/ 10¹⁸`?**

Different contracts, different decimal precision. The UBIScheme contract was designed with
2 decimal places (matching a "cents" mental model). The GoodDollar ERC20 token itself uses
18 decimal places (the Ethereum/ERC20 standard). The invite contract works with the raw ERC20
amounts, so 18 decimals applies. See §5 for the full explanation.

---

**Q: What is `earned_level` / `earnedLevel`?**

A boolean flag that tells us whether the bounty payout also caused the inviter to advance to
the next level. `earnedLevel = true` fires on the payout that pushes the inviter's conversion
count over the `toNext` threshold for their current level. It's informational; it doesn't
affect the `bountyPaid` amount in the same event (the level-up takes effect on *future*
payouts). **Note:** as of the current deployment, level advancement has not been activated
— all payouts are at level 0 and `earnedLevel` is always `false`.

---

**Q: What does it mean when `inviter_address` is NULL in `invite_payouts`?**

The payout was a campaign payout (user signed up via the general campaign code). No individual
inviter exists. `inviter_amount_g` is also NULL. These rows still contribute to
`total_g_to_invitees` but not to `total_g_to_inviters`.

---

**Q: I see a `bountyFor(address _invitee)` function in the contract ABI. What does it do?**

`bountyFor` is a read function you can call on the contract to ask "if this invitee's bounty
were collected today, how much would the inviter receive?" It reflects the inviter's current
level at query time. We don't use it in the warehouse because we already have the actual
`bountyPaid` value from the `InviterBounty` event.

---

## 11. Maintenance: What to Update and When

### If the invitee bounty amount changes

The invitee bounty is hardcoded as `CAST(500 AS BIGNUMERIC)` in one place:
`warehouse/L2/03_invite_payouts.sql` — both in `invitee_amount_g` and in the `total_amount_g`
`CASE` expressions.

Steps:
1. Confirm the new amount by reading `levels(0).bounty` from the contract on-chain, then
   dividing by 10¹⁸ to get the face value.
2. Update both occurrences of `500` in `03_invite_payouts.sql`.
3. Redeploy L2: `scripts/deploy-warehouse.ps1 L2`
4. Rebuild L3 tables (they materialise from the updated view):
   `scripts/refresh-marts.ps1`
5. Note: **historical rows** already in the `daily_invite_metrics` table will reflect the old
   amount. If you need historical correction, run the full table migration procedure in
   `docs/03_OPERATIONS.md §Rebuilding L3 tables from scratch`.

### If inviter bounty amounts change per level

No SQL change needed. `inviter_amount_g` is derived from `bountyPaid` — the chain value.
New payouts will automatically use the correct amount. Historical payouts are unaffected
(they already recorded the correct amount for their time).

### If the invite contract is replaced with a new deployment

1. Add the new contract address to the pipeline ingestion config.
2. Verify the new contract emits the same `InviteeJoined` and `InviterBounty` events (check
   the ABI in `contracts/ABIs/`).
3. If the event signatures match: no SQL changes needed. New events flow into the existing
   L1 table and L2 views.
4. If the event signatures changed: update the L1 table schema and L2 views accordingly.
5. Confirm the new contract's `_level0Bounty` initialization parameter and update
   `invitee_amount_g` in `invite_payouts.sql` if it differs from G$500.

### If a new payout type appears (not 'referral' or 'campaign')

The `payout_origin` CASE in `invite_payouts.sql` would classify it as `'referral'` by
default (the ELSE branch). Review the new contract behavior, add a new CASE branch if needed,
and update this document.
