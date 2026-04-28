# L2 Invite Entities

- [Invitee_Lifecycle](#invitee_lifecycle)
- [Inviter_Relationship](#inviter_relationship)
- [Invite_Signups](#invite_signups)
- [Invite_Payouts](#invite_payouts)



## Invitee_Lifecycle

<details>
<summary>View entity details</summary>

### Purpose

Stores the latest known lifecycle state for each invitee across signup, claiming activity, and bounty payout attribution.

### Grain

- 1 row per invitee address
- Mutable state table

### Source Tables

- [`BlockchainEvents.InviteContractEvents`](https://console.cloud.google.com/bigquery?ws=!1m5!1m4!4m3!1sgooddollar!2sBlockchainEvents!3sInviteContractEvents)

### Column Definitions

| Column | Type | Description |
|---|---|---|
| invitee_address | STRING | Wallet address of the invited user |
| inviter_address | STRING | Wallet address of the inviter tied to the signup |
| signup_type | STRING | Signup classification (`referral`, `campaign`) |
| signup_timestamp | TIMESTAMP | Timestamp of signup event |
| signup_tx_hash | STRING | Transaction hash of signup event |
| first_claim_timestamp | TIMESTAMP | Timestamp of first successful claim |
| latest_claim_timestamp | TIMESTAMP | Timestamp of most recent claim |
| total_claim_count | INTEGER | Total successful claims performed by invitee |
| bounty_tx_hash | STRING | Transaction hash of bounty payout |
| bounty_timestamp | TIMESTAMP | Timestamp of bounty payout |

### Business Rules

- Each invitee can only exist once in this table
- Latest claim timestamp must always reflect the newest known claim
- `first_claim_timestamp` is immutable after first population
- `total_claim_count` increments as new claims are detected
- Bounty fields remain `NULL` until payout occurs
- `inviter_address` equal to zero address indicates a `campaign` signup

### Update Behavior

- Append-only: No
- Mutable: Yes
- Upsert strategy: merge on `invitee_address`

### Example Downstream Use Cases

- Invitee conversion funnel analysis
- Claim retention analysis
- Time-to-first-claim metrics
- Referral effectiveness analysis
- User lifecycle segmentation

</details>



## Inviter_Relationship

<details>
<summary>View entity details</summary>

### Purpose

Stores immutable historical relationships between inviters and invitees at signup time.

### Grain

- 1 row per inviter → invitee relationship
- Append-only table

### Source Tables

- [`BlockchainEvents.InviteContractEvents`](https://console.cloud.google.com/bigquery?ws=!1m5!1m4!4m3!1sgooddollar!2sBlockchainEvents!3sInviteContractEvents)

### Column Definitions

| Column | Type | Description |
|---|---|---|
| invitee_address | STRING | Wallet address of invited user |
| inviter_address | STRING | Wallet address of inviter |
| signup_tx_hash | STRING | Transaction hash of signup |
| signup_timestamp | TIMESTAMP | Timestamp of signup event |

### Business Rules

- Relationship records are immutable after insertion
- Multiple invitees may map to the same inviter
- Relationship represents signup-time attribution state

### Update Behavior

- Append-only: Yes
- Mutable: No
- Insert strategy: insert new rows only

### Example Downstream Use Cases

- Referral graph construction
- Inviter performance analysis
- Network growth mapping
- Referral tree reconstruction

</details>



## Invite_Signups

<details>
<summary>View entity details</summary>

### Purpose

Stores raw signup event records generated through referral or campaign onboarding flows.

### Grain

- 1 row per signup event
- Append-only event table

### Source Tables

- [`BlockchainEvents.InviteContractEvents`](https://console.cloud.google.com/bigquery?ws=!1m5!1m4!4m3!1sgooddollar!2sBlockchainEvents!3sInviteContractEvents)

### Column Definitions

| Column | Type | Description |
|---|---|---|
| signup_tx_hash | STRING | Transaction hash of signup event |
| signup_tx_timestamp | TIMESTAMP | Timestamp of signup transaction |
| signup_type | STRING | Signup source classification (`inviter`, `referral`, `campaign`) |
| user_address | STRING | Wallet address of signing user |

### Business Rules

- Each row represents a discrete signup event
- Events should not be mutated after ingestion
- Duplicate transaction hashes should be prevented upstream

### Update Behavior

- Append-only: Yes
- Mutable: No
- Insert strategy: insert new rows only

### Example Downstream Use Cases

- Signup trend analysis
- Campaign attribution reporting
- Daily acquisition metrics
- Event-level auditing

</details>



## Invite_Payouts

<details>
<summary>View entity details</summary>

### Purpose

Stores bounty payout events associated with successful referrals or campaign completions.

### Grain

- 1 row per payout event
- Append-only event table

### Source Tables

- [`BlockchainEvents.InviteContractEvents`](https://console.cloud.google.com/bigquery?ws=!1m5!1m4!4m3!1sgooddollar!2sBlockchainEvents!3sInviteContractEvents)

### Column Definitions

| Column | Type | Description |
|---|---|---|
| bounty_tx_hash | STRING | Transaction hash of payout |
| bounty_tx_timestamp | TIMESTAMP | Timestamp of payout transaction |
| bounty_type | STRING | Payout classification (`referral`, `campaign`) |
| invitee_address | STRING | Wallet address of rewarded invitee |
| inviter_address | STRING | Wallet address of rewarded inviter |
| invitee_reward_amount | NUMERIC | Reward amount paid to invitee |
| inviter_reward_amount | NUMERIC | Reward amount paid to inviter |
| total_amount | NUMERIC | Total payout amount distributed |

### Business Rules

- Each row represents a finalized payout event
- Reward amounts should reflect on-chain settled values
- `total_amount` should equal invitee reward + inviter reward
- If `bounty_type` == `campaign` then only the `invitee` receives a bounty

### Update Behavior

- Append-only: Yes
- Mutable: No
- Insert strategy: insert new rows only

### Example Downstream Use Cases

- Referral incentive cost analysis
- Campaign payout accounting
- Reward distribution auditing
- CAC / incentive efficiency analysis

</details>