import type { Strategy } from '../strategy'
import { evDecide } from '../../ai-v2/ev-controller'

/**
 * Strategy adapter for v2 (EV-based AI). Phase 1: discard EV only;
 * everything else delegates to v1 defaultDecide internally.
 *
 * Use via:
 *   npx tsx scripts/verify.ts 50 0,0,0,0 8 --strategies=ev,,,
 */
export const Ev: Strategy = {
  name: 'ev',
  decide: evDecide,
}
