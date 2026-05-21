/**
 * onnxruntime-web wrapper. Single global session created lazily after the
 * model files are cached.
 */

// onnxruntime-web's default ESM bundle inlines the wasm — no wasmPaths
// setup needed. If we ever switch to './wasm' or './webgpu' entrypoints
// we'll have to wire wasmPaths via Vite ?url imports.
import * as ort from 'onnxruntime-web'

import {
  ensureCachedAtVersion,
  type FetchProgress,
  type VersionManifest,
} from './model-cache'

// Single-threaded WASM avoids the cross-origin-isolation requirement for
// SharedArrayBuffer. Multi-threaded / WebGPU is a future opt-in.
ort.env.wasm.numThreads = 1

const MODEL_GRAPH = 'main-best.onnx'
const MODEL_DATA = 'main-best.onnx.data'

export interface ModelInfo {
  graphSize: number
  dataSize: number
  version: string
  inputs: readonly string[]
  outputs: readonly string[]
}

let session: ort.InferenceSession | null = null
let info: ModelInfo | null = null
// In-flight load promise. Returned to subsequent callers so a concurrent
// loadModel() call (e.g., React StrictMode double-mount in dev) doesn't
// kick off a second InferenceSession.create() that races with the first.
let loadPromise: Promise<ort.InferenceSession> | null = null
// Serializes session.run() calls. onnxruntime-web's WASM proxy tracks an
// "active session" pointer and throws "Session mismatch" if two run()s land
// concurrently; serializing here keeps that invariant for callers.
let runChain: Promise<unknown> = Promise.resolve()

export function getSession(): ort.InferenceSession | null {
  return session
}

export function getModelInfo(): ModelInfo | null {
  return info
}

export interface LoadProgress {
  stage: 'graph' | 'data' | 'compile'
  loaded: number
  total: number
}

async function doLoad(
  baseUrl: string,
  manifest: VersionManifest,
  onProgress: (p: LoadProgress) => void,
): Promise<ort.InferenceSession> {
  if (session) {
    await session.release()
    session = null
    info = null
  }

  const graphBytes = await ensureCachedAtVersion(
    MODEL_GRAPH,
    `${baseUrl}/${MODEL_GRAPH}`,
    manifest.version,
    (p: FetchProgress) => onProgress({ stage: 'graph', loaded: p.loaded, total: p.total }),
  )
  const dataBytes = await ensureCachedAtVersion(
    MODEL_DATA,
    `${baseUrl}/${MODEL_DATA}`,
    manifest.version,
    (p: FetchProgress) => onProgress({ stage: 'data', loaded: p.loaded, total: p.total }),
  )

  onProgress({ stage: 'compile', loaded: 0, total: 1 })
  const created = await ort.InferenceSession.create(graphBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    externalData: [
      { path: MODEL_DATA, data: new Uint8Array(dataBytes) },
    ],
  })
  session = created
  info = {
    graphSize: graphBytes.byteLength,
    dataSize: dataBytes.byteLength,
    version: manifest.version,
    inputs: created.inputNames,
    outputs: created.outputNames,
  }
  onProgress({ stage: 'compile', loaded: 1, total: 1 })
  return created
}

/**
 * Load (or reload) the ONNX session at the given manifest version. Concurrent
 * calls share the same in-flight promise.
 */
export async function loadModel(
  baseUrl: string,
  manifest: VersionManifest,
  onProgress: (p: LoadProgress) => void,
): Promise<ort.InferenceSession> {
  if (session && info && info.version === manifest.version) return session
  if (loadPromise) return loadPromise
  loadPromise = doLoad(baseUrl, manifest, onProgress).finally(() => {
    loadPromise = null
  })
  return loadPromise
}

/**
 * Run a forward pass. Caller provides obs (Float32, (B, 1012, 34) flat) and
 * mask (bool / Uint8, (B, 46) flat). Returns q values (Float32, (B, 46) flat).
 *
 * Calls are serialized through `runChain` so concurrent callers can't trip the
 * ORT WASM proxy's "Session mismatch" guard.
 */
export async function infer(
  obs: Float32Array,
  obsShape: readonly [number, number, number],
  mask: Uint8Array,
  maskShape: readonly [number, number],
): Promise<{ q: Float32Array; qShape: readonly number[] }> {
  if (!session) throw new Error('infer() called before loadModel()')
  const next = runChain.then(async () => {
    const obsTensor = new ort.Tensor('float32', obs, [...obsShape])
    const maskTensor = new ort.Tensor('bool', mask, [...maskShape])
    const out = await session!.run({ obs: obsTensor, mask: maskTensor })
    const q = out.q
    return {
      q: q.data as Float32Array,
      qShape: q.dims,
    }
  })
  // Don't let an earlier rejection poison the chain.
  runChain = next.catch(() => undefined)
  return next
}
