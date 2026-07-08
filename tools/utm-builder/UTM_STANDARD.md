# GoodDollar UTM Naming Standard
*Version 1.0 — July 2026. Owner: Thales (Data). Applies to: all teams, all campaigns, all channels.*

---

## Why This Exists

Every link we share externally (social, email, Telegram, partner) should tell us **who clicked it, why, and from where**. Without UTMs, every visit looks like "direct" — zero attribution, zero insight into what's working.

This document defines **the one naming convention** the entire org uses. It's not optional, it's not per-project — it's the shared language that makes our analytics coherent.

---

## The Rules (Non-Negotiable)

| Rule | Why |
|------|-----|
| **Lowercase everything** | `Twitter` ≠ `twitter` in analytics. Pick one. We picked lowercase. |
| **Never UTM internal links** | UTMs on links *within* our own sites destroy attribution. External-inbound only. |
| **Always set all 3 core params** | Source + medium + campaign. Missing any one = broken data. |
| **Use the builder, not free-typing** | The [UTM Builder tool](https://gooddollar.github.io/data-team/utm-builder/) prevents typos and fragmentation. |
| **Dash between fields, underscore within words** | `antseed-acquisition-2026_07-launch_post` — always parseable. |

---

## The 3 Core Parameters

### `utm_source` — Who sent the traffic

The platform, partner, or channel that sent the click.

**Controlled values (use ONLY these):**

| Value | When to use |
|-------|-------------|
| `twitter` | Any post or link on X/Twitter |
| `telegram` | Telegram group, channel, or bot |
| `linkedin` | LinkedIn posts or messages |
| `facebook` | Facebook posts or ads |
| `discord` | Discord channel links |
| `email` | Newsletter, transactional, onboarding emails |
| `minipay` | Links from MiniPay integration |
| `valora` | Links from Valora |
| `fonbnk` | Links from Fonbnk |
| `antseed` | Links from AntSeed properties |
| `gooddapp` | Links from GoodDapp to GoodWallet |
| `community` | Community-generated content (ambassadors, UGC) |
| `partner_<name>` | Any other partner (e.g., `partner_kipu`) |
| `qr_<context>` | Physical QR codes (e.g., `qr_ethcc_booth`) |

> **Adding a new source:** [Open a data request](https://github.com/GoodDollar/data-team/issues/new?template=data-request.md) on the data-team repo. We'll add it to the builder and this list.

---

### `utm_medium` — Channel type

How the traffic reached us. Maps to standard channel groupings.

**Controlled values (use ONLY these):**

| Value | Meaning |
|-------|---------|
| `social` | Organic social media posts |
| `paid_social` | Paid social ads |
| `email` | Email of any kind |
| `referral` | Blog posts, news articles, external sites linking to us |
| `partner` | Partner app/integration links |
| `cpc` | Paid search (Google Ads, etc.) |
| `banner` | Display/banner ads |
| `push` | Push notifications |
| `sms` | SMS messages |
| `in_app` | In-app banners or notifications (only if they open a new session) |

---

### `utm_campaign` — Structured campaign name

This is where the intelligence lives. **Not free text** — it follows a structure:

```
<initiative>-<goal>-<date>-<name>
```

| Field | Type | Values |
|-------|------|--------|
| `initiative` | Dropdown | `ubi`, `antseed`, `builders`, `governance`, `general`, `minipay`, `superfluid` |
| `goal` | Dropdown | `awareness`, `acquisition`, `activation`, `retention`, `revenue` |
| `date` | Fixed format | `YYYY_MM` (when campaign launched) |
| `name` | Free text | snake_case, specific identifier |

**Examples:**
```
antseed-acquisition-2026_07-ai_credits_launch
ubi-awareness-2026_07-twitter_thread_series
governance-activation-2026_07-dao_vote_reminder
builders-acquisition-2026_08-season4_recruitment
superfluid-activation-2026_08-stream_tutorial
```

**Why this structure?** Because you can filter:
- `antseed-*` = everything Antseed
- `*-acquisition-*` = all acquisition campaigns
- `*-2026_07-*` = everything from July
- Regex is trivial. Reporting is trivial.

---

## Optional Parameters

### `utm_content` — Creative/variant differentiation

Use when you have multiple links in the same campaign pointing to the same page.

```
Format: snake_case, free text
Examples: banner_top, cta_blue, video_30s, thread_01, bio_link
```

### `utm_term` — Paid search keyword

Only relevant if/when we run paid search campaigns. Ignore until then.

---

## How to Generate a Tagged URL

### Step 1: Use the URL Builder

**→ [gooddollar.github.io/data-team/utm-builder](https://gooddollar.github.io/data-team/utm-builder/)**

The builder has dropdown validation for source, medium, initiative, and goal. You type only the destination URL, the `name`, and optional `content`. It auto-generates the full tagged URL with copy-to-clipboard.

### Step 2: Shorten if needed

Long UTM URLs look ugly in social posts. Use a shortener (Bitly, or our branded `go.gooddollar.org` when available). The UTMs survive through the redirect.

### Step 3: Share the shortened or full link

Never edit the UTM params after generating. If you need a variant, generate a new URL.

---

## Per-Channel Quick Reference

### Social (Twitter, Telegram, LinkedIn, Discord)
```
utm_source:   twitter | telegram | linkedin | discord
utm_medium:   social
utm_campaign: <initiative>-<goal>-<date>-<name>
utm_content:  thread_01 | post_video | bio_link | pinned_tweet (optional)
```

### Email
```
utm_source:   email
utm_medium:   email
utm_campaign: <initiative>-<goal>-<date>-<name>
utm_content:  header_cta | footer_link | inline_button (optional)
```

### Partner Integrations
```
utm_source:   minipay | valora | fonbnk | antseed | partner_<name>
utm_medium:   partner
utm_campaign: <initiative>-<goal>-<date>-<name>
utm_content:  app_banner | push_notification | in_app_card (optional)
```

### QR Codes
```
utm_source:   qr_<location_context>
utm_medium:   referral
utm_campaign: <initiative>-<goal>-<date>-<name>
utm_content:  poster_a4 | badge_back | screen_booth (optional)
```

---

## What This Enables

Once links are tagged consistently:

| Question | How it's answered |
|----------|-------------------|
| "Which channel drives the most wallet signups?" | Filter by `utm_medium` → conversion events |
| "Is the Antseed launch campaign working?" | Filter `utm_campaign` starts with `antseed-` |
| "Which Telegram post drove the most claims?" | Filter `utm_source=telegram` + `utm_content` |
| "How much traffic comes from partners vs organic?" | Group by `utm_medium` |
| "What's our acquisition cost per channel?" | `utm_medium` + spend data |

---

## Governance

| What | Who | How |
|------|-----|-----|
| Add new source/medium values | Thales (Data) | [Open a data request](https://github.com/GoodDollar/data-team/issues/new?template=data-request.md) |
| Add new initiative values | Thales + requestor | [Open a data request](https://github.com/GoodDollar/data-team/issues/new?template=data-request.md) |
| Annual audit (check for rogue values) | Thales | January each year |
| URL Builder maintenance | Thales | [data-team repo](https://github.com/GoodDollar/data-team) |

---

## FAQ

**Q: Do I need to UTM-tag every single link I share?**
A: Every *external* link that drives traffic to our properties (goodwallet.xyz, gooddapp.org, ai-credits-web.vercel.app, etc). Not internal links. Not links to external sites.

**Q: What if my campaign doesn't fit an initiative?**
A: Use `general`. If it keeps happening, we add a new initiative value.

**Q: Can I make up my own source/medium?**
A: No. Use the controlled values. If something's missing, [open a data request](https://github.com/GoodDollar/data-team/issues/new?template=data-request.md) and we'll add it.

**Q: Telegram strips my UTMs — what do I do?**
A: Use a shortener (Bitly, or our branded short link when available). The redirect preserves params through Telegram's link handler.

**Q: What about the AI credits widget specifically?**
A: See the companion doc: *Antseed AI Credits — Tracking Plan* (covers the full funnel including on-chain and backend metrics beyond UTMs).

---

*Last updated: 2026-07-08. Next review: 2026-08-01.*
