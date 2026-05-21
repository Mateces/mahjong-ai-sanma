/**
 * IndexedDB-backed cache for the ONNX model weights.
 *
 * Files are stored as ArrayBuffer keyed by name and tagged with a version
 * string. The splash screen compares each cached entry's version against the
 * server's `version.json` and only re-downloads when stale.
 */

const DB_NAME = 'mortal-pwa'
const DB_VERSION = 1
const STORE = 'models'

export interface CachedFile {
  name: string
  bytes: ArrayBuffer
  size: number
  version: string
  fetchedAt: number
}

export interface VersionManifest {
  version: string
  label: string
  files: string[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'name' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getCached(name: string): Promise<CachedFile | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(name)
    req.onsuccess = () => resolve((req.result as CachedFile | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

export async function putCached(file: CachedFile): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(file)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function fetchManifest(url: string): Promise<VersionManifest> {
  // cache: 'no-store' so the splash always sees the current version even when
  // the service worker would otherwise serve a stale copy.
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`)
  return res.json() as Promise<VersionManifest>
}

/**
 * Returns true iff every file in `manifest.files` is cached AND tagged with
 * the manifest's version.
 */
export async function isManifestCached(manifest: VersionManifest): Promise<boolean> {
  for (const name of manifest.files) {
    const hit = await getCached(name)
    if (!hit || hit.version !== manifest.version) return false
  }
  return true
}

export interface FetchProgress {
  loaded: number
  total: number
}

export async function fetchWithProgress(
  url: string,
  onProgress: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`)

  const total = Number(res.headers.get('Content-Length') ?? '0')
  if (!res.body) {
    const buf = await res.arrayBuffer()
    onProgress({ loaded: buf.byteLength, total: buf.byteLength })
    return buf
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    onProgress({ loaded, total })
  }
  const out = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out.buffer
}

/**
 * Ensure `name` is cached at `version`. If the cached copy is at a different
 * version (or missing) the file is re-fetched from `url` and the new bytes
 * replace the old entry.
 */
export async function ensureCachedAtVersion(
  name: string,
  url: string,
  version: string,
  onProgress: (p: FetchProgress) => void,
): Promise<ArrayBuffer> {
  const hit = await getCached(name)
  if (hit && hit.version === version) {
    onProgress({ loaded: hit.size, total: hit.size })
    return hit.bytes
  }
  const bytes = await fetchWithProgress(url, onProgress)
  await putCached({
    name,
    bytes,
    size: bytes.byteLength,
    version,
    fetchedAt: Date.now(),
  })
  return bytes
}
