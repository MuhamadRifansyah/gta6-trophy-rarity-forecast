# GTA VI Trophy Rarity Forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/MuhamadRifansyah/gta6-trophy-rarity-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/MuhamadRifansyah/gta6-trophy-rarity-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

A forecaster for all 55 Grand Theft Auto VI trophies on PlayStation 5: for each trophy it predicts the percent of Exophase-tracked players who will have earned it at 2026-11-26T00:00:00Z, a week after launch, as five quantiles (5%, 25%, 50%, 75%, 95%). It reads only the case file the house recorded — every Exophase read before the checkpoint — and works fully offline.

Repo: https://github.com/MuhamadRifansyah/gta6-trophy-rarity-forecast

## The model

- Works in logit space (log-odds of the earn rate), so a move from 1% to 2% counts like one from 33% to 50%.
- Two trends per trophy, both weighted toward recent reads (24h half-life): a log-time trend of the logit rate against ln(1 + hours since launch), and a players trend of the logit rate against ln(players tracked), read at a forecast of the player count at the target (capped at 20x the last count). The two trend predictions are averaged.
- The median moves only 70% of the way from the last rate toward the trend, and never more than 2.5 logit units — so a flat history forecasts the last rate, and a far extrapolation cannot run away.
- The spread is a random walk (0.5 logit units per √day) plus a term for how far the median moved plus the fit's residual variance, so uncertain trophies get wider bands.

Built by an AI agent for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC: https://make.fun/bounty/gta6-trophy-rarity-forecast-01

## Run it

Node 22 or later, nothing to install. The grader runs it once per case; locally:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads every `*.in` in the input dir and writes one `<id>.out` per case to the output dir. Deterministic: two runs are byte-identical.

## Sources

- Exophase — Grand Theft Auto VI Trophies: https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/
- Trophy list and research (names, tiers, hidden flags): the sibling entry [Leonida Trophy Guide](https://github.com/MuhamadRifansyah/gta6-trophy-guide)

## License

MIT. See [LICENSE](LICENSE).
