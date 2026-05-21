import { describe, expect, it } from 'vitest'
import { ActionKind } from '../../../game/types'
import type { Action, TileType } from '../../../game/types'
import { mjaiReactionToAction } from '../../mjai/emit'

function discard(tile: number): Action {
  return { kind: ActionKind.Discard, tile: tile as TileType }
}

function riichi(tile: number): Action {
  return { kind: ActionKind.Riichi, tile: tile as TileType }
}

function pon(called: number): Action {
  return { kind: ActionKind.Pon, called: called as TileType }
}

function chi(called: number, tiles: [number, number]): Action {
  return { kind: ActionKind.Chi, called: called as TileType, tiles: tiles as [TileType, TileType] }
}

function ron(called: number): Action {
  return { kind: ActionKind.Ron, called: called as TileType }
}

function tsumo(): Action {
  return { kind: ActionKind.Tsumo }
}

function ankan(tile: number): Action {
  return { kind: ActionKind.Ankan, tile: tile as TileType }
}

function kakan(tile: number): Action {
  return { kind: ActionKind.Kakan, tile: tile as TileType }
}

function pass(): Action {
  return { kind: ActionKind.Pass }
}

describe('mjaiReactionToAction', () => {
  describe('valid reactions mapping to legal actions', () => {
    it('maps dahai to matching discard', () => {
      const actions = [discard(0), discard(1), discard(5)]
      const result = mjaiReactionToAction({ type: 'dahai', pai: '2m' }, actions)
      expect(result).toEqual(discard(1))
    })

    it('maps reach to riichi', () => {
      const actions = [riichi(3)]
      const result = mjaiReactionToAction({ type: 'reach' }, actions)
      expect(result).toEqual(riichi(3))
    })

    it('maps pon to matching pon action', () => {
      const actions = [pon(32)]
      const result = mjaiReactionToAction({ type: 'pon', pai: 'F' }, actions)
      expect(result).toEqual(pon(32))
    })

    it('maps chi with matching consumed tiles', () => {
      const actions = [chi(1, [0, 2])]
      const result = mjaiReactionToAction(
        { type: 'chi', pai: '2m', consumed: ['1m', '3m'] },
        actions,
      )
      expect(result).toEqual(chi(1, [0, 2]))
    })

    it('maps hora to tsumo when available', () => {
      const actions = [tsumo()]
      const result = mjaiReactionToAction({ type: 'hora' }, actions)
      expect(result).toEqual(tsumo())
    })

    it('maps hora to ron when tsumo not available', () => {
      const actions = [ron(5)]
      const result = mjaiReactionToAction({ type: 'hora' }, actions)
      expect(result).toEqual(ron(5))
    })

    it('maps ankan to matching ankan action', () => {
      const actions = [ankan(10)]
      const result = mjaiReactionToAction({ type: 'ankan', consumed: ['2p', '2p', '2p', '2p'] }, actions)
      expect(result).toEqual(ankan(10))
    })

    it('maps kakan to matching kakan action', () => {
      const actions = [kakan(10)]
      const result = mjaiReactionToAction({ type: 'kakan', pai: '2p' }, actions)
      expect(result).toEqual(kakan(10))
    })

    it('maps ryukyoku to kyushukyuhai', () => {
      const actions = [{ kind: ActionKind.Kyushukyuhai }]
      const result = mjaiReactionToAction({ type: 'ryukyoku' }, actions)
      expect(result?.kind).toBe(ActionKind.Kyushukyuhai)
    })

    it('maps none to pass', () => {
      const actions = [pass()]
      const result = mjaiReactionToAction({ type: 'none' }, actions)
      expect(result).toEqual(pass())
    })
  })

  describe('hallucinated / illegal reactions', () => {
    it('returns null when dahai tile is not in legal discards', () => {
      // Model wants to discard 白(F) but hand only has 1m-6m
      const actions = [discard(0), discard(1), discard(2), discard(3), discard(4), discard(5)]
      const result = mjaiReactionToAction({ type: 'dahai', pai: 'F' }, actions)
      expect(result).toBeNull()
    })

    it('returns null when dahai tile does not match any legal action tile', () => {
      const actions = [discard(10), discard(11)]
      const result = mjaiReactionToAction({ type: 'dahai', pai: '1m' }, actions)
      expect(result).toBeNull()
    })

    it('returns null when chi consumed do not match', () => {
      const actions = [chi(5, [3, 4])]
      const result = mjaiReactionToAction(
        { type: 'chi', pai: '6m', consumed: ['5m', '7m'] },
        actions,
      )
      expect(result).toBeNull()
    })

    it('returns null when reach but no riichi in legal set', () => {
      const actions = [discard(0), discard(1)]
      const result = mjaiReactionToAction({ type: 'reach' }, actions)
      expect(result).toBeNull()
    })

    it('returns null when pon tile does not match', () => {
      const actions = [pon(32)]
      const result = mjaiReactionToAction({ type: 'pon', pai: 'P' }, actions)
      expect(result).toBeNull()
    })

    it('returns null when kakan tile does not match', () => {
      const actions = [kakan(10)]
      const result = mjaiReactionToAction({ type: 'kakan', pai: '1m' }, actions)
      expect(result).toBeNull()
    })

    it('returns null when hora but no tsumo or ron in legal set', () => {
      const actions = [pass()]
      const result = mjaiReactionToAction({ type: 'hora' }, actions)
      expect(result).toBeNull()
    })

    it('returns null for unknown reaction type', () => {
      const actions = [discard(0)]
      const result = mjaiReactionToAction({ type: 'unknown_type' } as never, actions)
      expect(result).toBeNull()
    })
  })
})
