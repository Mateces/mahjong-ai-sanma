import type { Strategy } from '../strategy'

const REGISTRY = new Map<string, Strategy>()

/**
 * Register a Strategy by its name. Later calls with the same name overwrite
 * the previous entry — useful in tests and for re-loading.
 */
export function registerStrategy(strategy: Strategy): void {
  REGISTRY.set(strategy.name, strategy)
}

/**
 * Look up a Strategy by name. Returns null when no such strategy was
 * registered — callers can treat that as "use default AI for this seat".
 */
export function getStrategy(name: string): Strategy | null {
  return REGISTRY.get(name) ?? null
}

/**
 * Names of all currently-registered strategies. Mainly for diagnostics
 * (e.g. verify CLI printing the available strategies on bad input).
 */
export function listStrategies(): string[] {
  return [...REGISTRY.keys()]
}
