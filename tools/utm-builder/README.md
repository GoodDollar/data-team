# GoodDollar UTM Builder

A browser-based form for generating correctly-formatted UTM tracking URLs — no free-typing, no typos, no broken attribution.

**→ [Open the UTM Builder](https://gooddollar.github.io/data-team/utm-builder/)**

---

## Quick reference

Campaign name format:

```
<initiative>-<goal>-<YYYY_MM>-<name>
```

Example: `antseed-acquisition-2026_07-ai_credits_launch`

See [UTM_STANDARD.md](UTM_STANDARD.md) for the full naming standard, per-channel quick references, and governance.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | The tool — self-contained, no build step, no dependencies |
| `config.json` | Controlled dropdown values (sources, mediums, initiatives, goals) |
| `UTM_STANDARD.md` | Full naming standard, user guide, and governance |

## Updating the taxonomy

Edit `config.json` + update the matching table in `UTM_STANDARD.md` → open a PR. The tool reloads values from `config.json` at runtime — no build step needed.
