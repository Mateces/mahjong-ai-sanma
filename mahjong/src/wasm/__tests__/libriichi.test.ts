import { describe, expect, it } from 'vitest'
import {
  ACTION_SPACE,
  OBS_SHAPE_4,
  PlayerState,
  obsShape,
  shanten,
  tileIdToString,
  tileStringToId,
} from '../libriichi'

describe('libriichi-wasm', () => {
  it('reports the expected constants', () => {
    expect(ACTION_SPACE).toBe(46)
    expect(OBS_SHAPE_4).toEqual([1012, 34])
    expect(obsShape(3)).toEqual([934, 34])
  })

  it('round-trips tile ids — including red dora', () => {
    expect(tileIdToString(0)).toBe('1m')
    expect(tileIdToString(33)).toBe('C')
    expect(tileIdToString(34)).toBe('5mr')
    expect(tileStringToId('1m')).toBe(0)
    expect(tileStringToId('5mr')).toBe(34)
  })

  it('computes shanten of a tenpai hand', () => {
    // 1m1m 1p2p3p 4p5p6p 7p8p9p 1s2s — waiting on 3s
    expect(shanten([0, 0, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])).toBe(0)
  })

  it('drives a PlayerState through start_kyoku + tsumo', () => {
    const ps = new PlayerState(0)
    try {
      const startKyoku = {
        type: 'start_kyoku',
        bakaze: 'E',
        dora_marker: '7m',
        kyoku: 1,
        honba: 0,
        kyotaku: 0,
        oya: 0,
        scores: [25000, 25000, 25000, 25000],
        tehais: [
          ['1m', '4m', '2p', '6p', '7p', '1s', '3s', '6s', 'S', 'W', 'N', 'N', 'F'],
          Array(13).fill('?'),
          Array(13).fill('?'),
          Array(13).fill('?'),
        ],
      }
      ps.applyEvent(startKyoku)

      const candidate = ps.applyEvent({ type: 'tsumo', actor: 0, pai: '4p' })
      expect(candidate.can_discard).toBe(true)
      expect(candidate.can_ankan).toBe(false)
      expect(candidate.target_actor).toBe(0)

      const obs = ps.encodeObs(4, false)
      expect(obs.length).toBe(1012 * 34)

      const mask = ps.encodeObsMask(4, false)
      expect(mask.length).toBe(ACTION_SPACE)
      const legal = [...mask].filter((m) => m === 1).length
      // 13 hand tiles + drawn 4p = up to 14 tiles, but some are duplicates.
      // We at least expect some discards to be legal.
      expect(legal).toBeGreaterThan(5)
    } finally {
      ps.dispose()
    }
  })
})
