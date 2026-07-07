# Business Glossary And AI Disambiguation

This is the living glossary for GoodDollar onchain analytics. It defines the language that humans, dashboards, Metabase, and a future custom AI analyst must share.

The glossary will evolve as new contracts, events, chains, and stakeholder questions enter the system. Ambiguous language should be added here as soon as it causes confusion.

## Core Rule

If a user asks an ambiguous question, the AI must ask targeted clarification questions before running analysis.

The goal is not to make users speak like analysts. The goal is to help them reveal what they are trying to decide, what deliverable they need, and which data concept actually supports that decision.

## AI Disambiguation Protocol

Before running analysis, the AI should identify:

| Question | Why it matters |
|---|---|
| What decision or deliverable is this for? | A board update, CEO check-in, campaign review, debugging task, or operational alert may need different precision and caveats. |
| What entity do you mean? | Users, wallets, claimers, invitees, inviters, transactions, events, and transfers are different things. |
| What time window do you mean? | Latest closed day, last 7 closed days, calendar week, campaign period, all-time, or custom range. |
| Which chain or scope? | XDC-only, all chains, one contract, one campaign, or all GoodDollar activity. |
| What output do you need? | A number, table, chart, dashboard, explanation, anomaly investigation, or export. |
| How should the answer be used? | Strategic decision, public reporting, internal debugging, budget/cost evaluation, or product investigation. |

The AI should not ask every question every time. It should ask only the questions needed to remove ambiguity that would change the answer.

## Required Answer Format For AI Analyst Mode

Every non-trivial answer should include:

- short interpretation of the user's question
- scope: chain, contract/domain, date range, and freshness
- model/table references
- SQL executed or generated
- BigQuery job ID or execution reference when available
- result
- caveats and known limitations
- suggested follow-up only when it materially changes the decision

## Freshness Language

| Term | Definition |
|---|---|
| Latest closed day | Yesterday in UTC: `CURRENT_DATE() - 1`. This is the default freshest business-facing data. |
| Current day / today | Partial day. Do not use in business-facing analytics unless the user explicitly asks for intraday or partial data. |
| Fresh data | Data through the latest closed day after ingestion and dbt transformation have both completed. |
| Stale data | Data where sources or marts have not refreshed within the documented freshness threshold. |

Default AI prompt when freshness is unclear:

> Do you want the latest complete data through yesterday, or are you intentionally asking for partial today?

## Entity Terms

| Term | Canonical meaning | Do not confuse with | Canonical source |
|---|---|---|---|
| Wallet | A blockchain address. This is not guaranteed to equal one real human. | user, account, person | L1/L2 address columns |
| User | Ambiguous. Must be clarified. Could mean claimer, invitee, inviter, unique wallet, active wallet, or app account. | any specific entity unless clarified | Ask disambiguation question |
| Claimer | Wallet that emitted or is associated with a UBI claim event. | invitee, active user | `Semantic.claim_events`, `Semantic.claimer_activity` |
| Active claimer | Needs a time window. Usually a wallet with at least one claim in the selected period. | lifetime claimer | `Semantic.claim_events` |
| Invitee | Wallet that joined through the invite program as the invited participant. | inviter, no-code inviter signup | `Semantic.invite_signups`, `Semantic.invitee` |
| Inviter | Wallet whose invite link/code brought another participant into the program. | invitee, campaign address | `Semantic.invite_signups`, `Semantic.invite_payouts` |
| Campaign signup | Invite signup where the inviter field is the contract address, meaning no human inviter. | referral signup, no-code signup | `Semantic.invite_signups` |
| Referral signup | Invite signup where a real human wallet is the inviter. | campaign signup, no-code signup | `Semantic.invite_signups` |
| No-code signup | Signup with zero-address inviter. This user joined to become an inviter and is not tracked as an invitee in the lifecycle model. | campaign signup, referral signup | `Semantic.invite_signups` |

Default AI prompt for "users":

> When you say users, do you mean unique wallets that claimed UBI, invitees who signed up, active claimers in a time window, or all wallets with any GoodDollar event?

## Event, Transaction, And Transfer Terms

| Term | Canonical meaning | Do not confuse with | Canonical source |
|---|---|---|---|
| Blockchain transaction | A chain transaction identified by `tx_hash`. One transaction can emit multiple logs/events and include token transfers. | event, transfer | L1 common columns |
| Contract event | A decoded smart contract log. One row in an L1 event table usually represents one event log. | transaction, token transfer | `BlockchainEvents.*`, Staging models |
| Token transfer | Movement of token balance, usually emitted by ERC20 `Transfer`. Not every transaction or contract event is a token transfer. | transaction, invite payout event | Future ERC20 transfer source |
| UBI claim | A `UBIClaimed` contract event from UBIScheme. | token transfer, app session | `Semantic.claim_events` |
| Invite signup event | An `InviteeJoined` event from the invite contract. | app signup outside contract, bounty payout | `Semantic.invite_signups` |
| Invite payout event | An `InviterBounty` event from the invite contract. | ERC20 transfer, signup | `Semantic.invite_payouts` |

Default AI prompt for "transactions":

> Do you mean blockchain transactions (`tx_hash`), decoded contract events/logs, or token transfers? These produce different counts.

## Invite Program Metrics

| Term | Canonical meaning | Formula/source | Notes |
|---|---|---|---|
| Invite signup | Any `InviteeJoined` event, including referral, campaign, and no-code. | `Semantic.invite_signups` | Use `signup_type` to split. |
| Referral invitee | Invite signup with `signup_type = 'referral'`. | `Semantic.invite_signups` | Human inviter exists. |
| Campaign invitee | Invite signup with `signup_type = 'campaign'`. | `Semantic.invite_signups` | No human inviter. |
| Bounty paid | Invitee received invite payout after onboarding requirements. | `Semantic.invite_payouts`, `Semantic.invitee` | Timing may differ from modeled eligibility. |
| Invitee reward | Fixed G$500 invitee portion. | `invitee_amount_g` | Derived from protocol constant. |
| Inviter reward | Human inviter portion. | `inviter_amount_g` | Null for campaign payouts. |
| Total bounty expenditure | Invitee reward plus inviter reward actually disbursed. | `total_amount_g` / mart sums | Does not equal notional retained. |
| Notional campaign retained | G$1000 per campaign payout not disbursed to a human inviter. | `daily_notional_campaign_retained_g` | Bookkeeping line, not human payout. |
| Invite conversion | Ambiguous unless stage is specified. | `Marts.invite_funnel_snapshot` | Ask which funnel stages or KPI definition. |
| Met eligibility | 3+ claims on invite network and 7+ days since signup. | `Semantic.invitee`, funnel mart | Computed as-of latest closed day for business-facing analytics. |

Default AI prompt for "conversion":

> Which conversion do you mean: signup to first claim, signup to 3+ claims, signup to eligibility, or signup to bounty paid?

## Claim Metrics

| Term | Canonical meaning | Formula/source | Notes |
|---|---|---|---|
| Claim | One `UBIClaimed` event. | `Semantic.claim_events` | Grain is one event/log. |
| Daily claims | Count of claim events per date and network. | `Marts.daily_claim_activity.daily_claims` | Uses latest closed day by default. |
| Daily unique claimers | Distinct claimers per date and network. | `Marts.daily_claim_activity.daily_unique_claimers` | Same wallet counted once per day. |
| G$ claimed | Human-readable claim amount after raw amount divided by 100. | `Semantic.claim_events.amount_g` | Raw field remains `amount_raw`. |
| Cumulative unique claimers approx | Sum of daily unique claimers. | `Marts.daily_claim_activity.cumulative_unique_claimers_approx` | Approximate and overcounts repeat claimers. Do not use as exact unique users. |

## Disambiguation Examples

### User asks: "How many transactions happened last month?"

Ask:

> Do you mean blockchain transactions, decoded contract events, or token transfers? Also, should this cover claims, invites, or all GoodDollar contracts currently in the warehouse?

### User asks: "How many users do we have?"

Ask:

> Do you mean unique wallets that claimed, invitees who signed up, wallets active in a specific period, or all wallets with any GoodDollar event? What time window should I use?

### User asks: "Did the campaign work?"

Ask:

> Are you trying to evaluate acquisition volume, invite conversion to bounty paid, post-payout retention, or G$ cost per successful invitee? I can answer all of these, but they use different metrics.

### User asks: "How much did we spend?"

Ask:

> Do you mean G$ bounty expenditure, invitee-only rewards, inviter rewards, total UBI claimed, or another token/cost measure?

## Glossary Maintenance Rules

Add or update an entry when:

- a new model introduces a user-facing term
- a stakeholder uses a term ambiguously
- two teams use different words for the same metric
- a metric changes definition
- an AI answer needed a clarification not captured here

Each update should include the canonical source model and a disambiguation prompt if the term can be misunderstood.
