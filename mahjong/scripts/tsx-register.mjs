// Preflight: registers the tsx ESM loader in the current process so that
// .ts files can be imported. Used via `--import ./scripts/tsx-register.mjs`
// when spawning worker_threads, where tsx's auto-register is gated to
// main-thread-only and so doesn't apply.
import { register } from 'tsx/esm/api'
register()
