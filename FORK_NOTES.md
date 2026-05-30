# mahjong-ai-sanma

Fork from: /Users/cat/mahjong-ai (commit at b18d4a69de8b7d1b5cddead2a842613a66dfdd34)
Forked at: 2026-05-21T02:06:37Z
Purpose: 三人立直麻将 (sanma) AI training and verification

## Sanma rule parameters (locked)
- Players: 3
- Tiles: 108 (no 2-8m)
- Chi: disabled
- Nukidora (拔北): N tile auto-removed as bonus dora
- Tsumo loss (自摸损): missing player's share is not paid
- Round: 半庄 (East 1-3 + South 1-3 = 6 局)
- Red dora: 0/1/1 (m/p/s) — no red 5m, 1 red 5p, 1 red 5s

## Companion project
mortal-sanma at /Users/cat/mortal-sanma — forked libriichi + Brain

## Arena (model-vs-model)

`scripts/arena_self_play.py` runs sanma OneVsTwo: challenger rotates seats 0/1/2
across 3 splits per seed (so each seed yields 3 hanchans).

```
python scripts/arena_self_play.py \
    --challenger checkpoints/sanma-main.pth \
    --champion   checkpoints/sanma-main-best.pth \
    --seed-base 30000 --seed-key 0 --seeds 50 \
    --log-dir arena_runs/main_vs_best_50 \
    --disable-progress-bar
```

Reports rankings as `[#1, #2, #3]` with avg_rank and avg_pt (pt table
`[60, 0, -60]`, Tenhou-style approximation). Per-game `.json.gz` mjai logs
are written when `--log-dir` is set.

Sanma rule fixes that landed in mortal-sanma `libriichi/src/{arena/board.rs,
state/update.rs}` to make the arena correct for 3-player rules:

- `BoardState::tiles_left` default: 70 → 55 (sanma haipai trigger).
- `BoardState::can_four_wind` default: true → false (no 四風連打 in sanma).
- `Event::Nukidora` now drives `tsumo_actor` + `deal_from_rinshan` so the
  draw after kita-nuki goes from rinshan as required.
- `update::nukidora()` increments `kans_on_board` so kan + kita-nuki share
  the 4-slot rinshan budget; `can_nukidora` masks out once
  `kans_on_board >= 4`.

Verified: 50 seeds × 3 splits = 150 hanchans complete cleanly with
`sanma-main` vs `sanma-main-best` (rankings `[55, 44, 51]`, avg_rank 1.97).
