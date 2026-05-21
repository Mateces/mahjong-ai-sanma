/**
 * Side-effect module: register every built-in Strategy here so callers
 * that resolve strategies by name (verify CLI, tools) see them.
 *
 * Add a new strategy by:
 *   1. Implementing the Strategy interface in a sibling file
 *      (e.g. `defense-first.ts`).
 *   2. Importing it here and calling `registerStrategy(...)`.
 */

import { registerStrategy } from './registry'
import { DefenseFirst } from './defense-first'
import { SmartRiichi } from './smart-riichi'
import { Mainstream } from './mainstream'
import { Ev } from './ev'

registerStrategy(DefenseFirst)
registerStrategy(SmartRiichi)
registerStrategy(Mainstream)
registerStrategy(Ev)
