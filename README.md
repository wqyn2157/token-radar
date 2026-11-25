# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/wqyn2157/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/wqyn2157/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Ranks the protocols that still record no token by what their launch would be worth, and shows how to farm each one. Built for the make.fun token-radar-01 bounty from a sealed DefiLlama snapshot: no live data, no network, everything derived from the snapshot itself.

## The board

178 launch candidates, the whole 40-protocol watchlist included. Every row carries an implied value, the numbers behind it, and a four-step farm plan with a capital tier, costs and a hold time.

## How the value is derived

- **Category multiple**: the median market-cap/TVL of the snapshot's tokenised protocols in the same category, shrunk toward the global median (0.223) with a pseudo-count of 6 and clamped to [0.03, 2.5].
- **Implied value** = TVL × multiple × momentum (the 7-day TVL change, clamped) × maturity (protocol age from `listed_at`, capped at three years) × reach (chain count, capped).
- **Score**: the implied value log-normalised across the board to 0–100.

Eligibility follows the watchlist's own rule — pre-token, no versioned names, no wrapped/staked wording, no exchange-name prefixes, and not a bridge, CEX, liquid-staking or restaking category — extended below the $50M floor until the board holds at least 100 rows.

## Run it

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node 22, standard library only. The run writes `board.json`, `data.js`, the static `dashboard/` (board, per-protocol detail views, filters — it renders offline from `data.js`), the three `screenshots/`, and `dossier.json`, then re-reads the written board and verifies its ranks and watchlist coverage before declaring success.

## Layout

- `main.ts` — the runner and gate
- `lib/model.ts` — snapshot parsing, the valuation model, farm plans, the board gate
- `vendor/makefun-board.ts` — the vendored dossier builder from the competition kit
- `dashboard/` — the static page; `screenshots/` — board, detail and filtered views of it
