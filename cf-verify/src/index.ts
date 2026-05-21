// Cloudflare Worker: Mahjong distributed verify coordinator
// KV-backed, adaptive batch scheduling, HTML dashboard

interface Env {
  KV: KVNamespace;
  WORKER_TOKEN: string;
  ADMIN_TOKEN: string;
}

interface JobConfig {
  job_id: string;
  total: number;
  strategies: string;
  difficulties: string;
  end_round: number;
  shuffle_seats: boolean;
  created_at: number;
  batch_base: number;
}

interface WorkerState {
  name: string;
  claimed: number[];
  completed: number[];
  total_hanchans: number;
  total_elapsed: number;
  speed_hps: number; // hanchans per second
  last_seen: number;
}

interface BatchState {
  id: number;
  size: number;
  status: "pending" | "claimed" | "completed";
  worker: string | null;
  claimed_at: number | null;
  completed_at: number | null;
  results: any | null;
}

const TARGET_BATCH_DURATION = 60; // seconds — each worker reports ~every 1 min
const DEFAULT_BATCH_SIZE = 2;
const CLAIM_TIMEOUT = 600; // seconds
const MIN_BATCH = 2;
const MAX_BATCH = 200;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (e: any) {
      console.error("UNCAUGHT:", e?.message, e?.stack);
      return new Response(
        JSON.stringify({
          error: "internal",
          message: e?.message ?? String(e),
          stack: e?.stack ?? null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Dashboard (no auth needed)
    if (path === "/" && request.method === "GET") {
      return serveDashboard(env);
    }

    // Auth check for API endpoints
    const auth = request.headers.get("Authorization");
    const token = auth?.replace("Bearer ", "") ?? "";
    const isWorker = token === env.WORKER_TOKEN;
    const isAdmin = token === env.ADMIN_TOKEN;

    if (path === "/status" && request.method === "GET") {
      return handleStatus(env);
    }
    if (path === "/jobs" && request.method === "GET") {
      return handleJobs(env);
    }
    if (path === "/claim" && request.method === "POST") {
      if (!isWorker && !isAdmin) return json({ error: "unauthorized" }, 401);
      return handleClaim(request, env);
    }
    if (path === "/report" && request.method === "POST") {
      if (!isWorker && !isAdmin) return json({ error: "unauthorized" }, 401);
      return handleReport(request, env);
    }
    if (path === "/aggregate" && request.method === "GET") {
      return handleAggregate(env, url.searchParams.get("job") ?? null, url.searchParams.get("worker") ?? null);
    }
    if (path === "/job" && request.method === "POST") {
      if (!isAdmin) return json({ error: "admin only" }, 403);
      return handleCreateJob(request, env);
    }
    if (path === "/job" && request.method === "PATCH") {
      if (!isAdmin) return json({ error: "admin only" }, 403);
      return handleUpdateJob(request, env);
    }

    return json({ error: "not found" }, 404);
}

// ─── Handlers ──────────────────────────────────────────────────────

async function handleCreateJob(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const job_id = crypto.randomUUID().slice(0, 8);
  const config: JobConfig = {
    job_id,
    total: body.total ?? 2000,
    strategies: body.strategies ?? "",
    difficulties: body.difficulties ?? "0,0,0,0",
    end_round: body.end_round ?? 8,
    shuffle_seats: body.shuffle_seats ?? true,
    created_at: Date.now(),
    batch_base: body.batch_base ?? DEFAULT_BATCH_SIZE,
  };
  await env.KV.put("job:current", job_id);
  await env.KV.put(`job:${job_id}:config`, JSON.stringify(config));
  // Add to job list
  const jobList: string[] = JSON.parse((await env.KV.get("job:list")) ?? "[]");
  jobList.push(job_id);
  await env.KV.put("job:list", JSON.stringify(jobList));
  return json({ ok: true, job_id, config });
}

async function handleUpdateJob(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const jobId = body.job_id ?? (await env.KV.get("job:current"));
  if (!jobId) return json({ error: "no job" }, 404);
  const raw = await env.KV.get(`job:${jobId}:config`);
  if (!raw) return json({ error: "job not found" }, 404);
  const config: JobConfig = JSON.parse(raw);
  if (body.total !== undefined) config.total = body.total;
  await env.KV.put(`job:${jobId}:config`, JSON.stringify(config));
  if (body.set_current) await env.KV.put("job:current", jobId);
  return json({ ok: true, job_id: jobId, config });
}

async function handleJobs(env: Env): Promise<Response> {
  const jobList: string[] = JSON.parse((await env.KV.get("job:list")) ?? "[]");
  const currentId = await env.KV.get("job:current");
  const jobs = [];
  for (const id of jobList) {
    const raw = await env.KV.get(`job:${id}:config`);
    if (!raw) continue;
    const config: JobConfig = JSON.parse(raw);
    const aggRaw = await env.KV.get(`job:${id}:agg`);
    const agg = aggRaw ? JSON.parse(aggRaw) : { hanchans_done: 0, batches_completed: 0 };
    jobs.push({
      job_id: id,
      strategies: config.strategies,
      total: config.total,
      hanchans_done: agg.hanchans_done,
      batches_completed: agg.batches_completed,
      is_current: id === currentId,
      created_at: config.created_at,
    });
  }
  return json({ jobs });
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const workerName = body.worker ?? "unknown";
  const jobId = await env.KV.get("job:current");
  if (!jobId) return json({ error: "no active job" }, 404);

  const config: JobConfig = JSON.parse((await env.KV.get(`job:${jobId}:config`))!);

  // Check if done (use aggregate hanchans_done)
  const aggRaw = await env.KV.get(`job:${jobId}:agg`);
  const agg = aggRaw ? JSON.parse(aggRaw) : { hanchans_done: 0 };
  if (agg.hanchans_done >= config.total) {
    return json({ done: true });
  }

  // Get or create worker state
  let ws: WorkerState = await loadWorker(env, jobId, workerName);

  // Compute adaptive batch size
  const batchSize = ws.speed_hps > 0
    ? Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(ws.speed_hps * TARGET_BATCH_DURATION)))
    : config.batch_base;

  // Simple counter — just increment and hand out work
  const counterKey = `job:${jobId}:counters`;
  const counters: { next_id: number; assigned: number } = JSON.parse(
    (await env.KV.get(counterKey)) ?? '{"next_id":0,"assigned":0}'
  );
  const newId = counters.next_id;
  counters.next_id += 1;
  counters.assigned += batchSize;
  await env.KV.put(counterKey, JSON.stringify(counters));

  // Update worker state
  ws.last_seen = Date.now();
  await saveWorker(env, jobId, ws);

  return json({
    batch_id: newId,
    batch_size: batchSize,
    strategies: config.strategies,
    difficulties: config.difficulties,
    end_round: config.end_round,
    shuffle_seats: config.shuffle_seats,
  });
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json();
  const { batch_id, worker, elapsed_seconds, results } = body;
  const jobId = await env.KV.get("job:current");
  if (!jobId) return json({ error: "no active job" }, 404);

  // Update batch
  const batchKey = `job:${jobId}:batch:${batch_id}`;
  let batch: BatchState | null = JSON.parse((await env.KV.get(batchKey)) ?? "null");
  if (!batch) {
    batch = {
      id: batch_id, size: results?.hanchans_completed ?? 5,
      status: "completed", worker, claimed_at: Date.now(),
      completed_at: Date.now(), results,
    };
  } else {
    batch.status = "completed";
    batch.completed_at = Date.now();
    batch.results = results;
  }
  await env.KV.put(batchKey, JSON.stringify(batch));

  // Incremental aggregate update
  if (results?.per_player) {
    const aggKey = `job:${jobId}:agg`;
    const aggRaw = await env.KV.get(aggKey);
    const agg = aggRaw ? JSON.parse(aggRaw) : {
      hanchans_done: 0,
      batches_completed: 0,
      per_player: Array.from({ length: 4 }, () => ({
        rank_sum: 0, rank_dist: [0, 0, 0, 0],
      })),
    };
    agg.hanchans_done += results.hanchans_completed ?? batch.size;
    agg.batches_completed += 1;
    for (let p = 0; p < 4; p++) {
      const ps = results.per_player[p];
      if (!ps) continue;
      agg.per_player[p].rank_sum += ps.rank_sum ?? 0;
      for (let r = 0; r < 4; r++) {
        agg.per_player[p].rank_dist[r] += ps.rank_dist?.[r] ?? 0;
      }
    }
    await env.KV.put(aggKey, JSON.stringify(agg));

    // Per-worker aggregate
    const wAggKey = `job:${jobId}:agg:${worker}`;
    const wAggRaw = await env.KV.get(wAggKey);
    const wAgg = wAggRaw ? JSON.parse(wAggRaw) : {
      hanchans_done: 0, per_player: Array.from({ length: 4 }, () => ({
        rank_sum: 0, rank_dist: [0, 0, 0, 0],
      })),
    };
    wAgg.hanchans_done += results.hanchans_completed ?? batch.size;
    for (let p = 0; p < 4; p++) {
      const ps = results.per_player[p];
      if (!ps) continue;
      wAgg.per_player[p].rank_sum += ps.rank_sum ?? 0;
      for (let r = 0; r < 4; r++) {
        wAgg.per_player[p].rank_dist[r] += ps.rank_dist?.[r] ?? 0;
      }
    }
    await env.KV.put(wAggKey, JSON.stringify(wAgg));
  }

  // Update worker state
  let ws = await loadWorker(env, jobId, worker);
  ws.completed.push(batch_id);
  ws.total_hanchans += results?.hanchans_completed ?? batch.size;
  ws.total_elapsed += elapsed_seconds ?? 0;
  ws.speed_hps = ws.total_elapsed > 0 ? ws.total_hanchans / ws.total_elapsed : 0;
  ws.last_seen = Date.now();
  await saveWorker(env, jobId, ws);

  // Get current completed count from cache
  const aggRaw2 = await env.KV.get(`job:${jobId}:agg`);
  const completed = aggRaw2 ? JSON.parse(aggRaw2).batches_completed : 1;

  return json({
    ok: true,
    completed,
    total_batches: completed,
    your_speed: ws?.speed_hps ?? 0,
  });
}

async function handleStatus(env: Env): Promise<Response> {
  const jobId = await env.KV.get("job:current");
  if (!jobId) return json({ error: "no active job" }, 404);

  const config: JobConfig = JSON.parse((await env.KV.get(`job:${jobId}:config`))!);
  const aggRaw = await env.KV.get(`job:${jobId}:agg`);
  const agg = aggRaw ? JSON.parse(aggRaw) : { hanchans_done: 0, batches_completed: 0 };
  const workers = await getAllWorkers(env, jobId);

  const total_speed = workers.reduce((s, w) => s + w.speed_hps, 0);
  const remaining = config.total - agg.hanchans_done;
  const eta_seconds = total_speed > 0 ? remaining / total_speed : null;

  return json({
    job_id: jobId,
    total: config.total,
    strategies: config.strategies,
    hanchans_done: agg.hanchans_done,
    batches_completed: agg.batches_completed,
    batches_claimed: 0,
    batches_total: 0,
    remaining,
    eta_seconds,
    workers: workers.map(w => ({
      name: w.name,
      speed_hps: Math.round(w.speed_hps * 1000) / 1000,
      hanchans_done: w.total_hanchans,
      batches_done: w.completed.length,
      last_seen_ago: Math.round((Date.now() - w.last_seen) / 1000),
    })),
  });
}

async function handleAggregate(env: Env, requestedJobId: string | null, workerFilter: string | null): Promise<Response> {
  const jobId = requestedJobId ?? await env.KV.get("job:current");
  if (!jobId) return json({ error: "no active job" }, 404);

  const aggKey = workerFilter ? `job:${jobId}:agg:${workerFilter}` : `job:${jobId}:agg`;
  const aggRaw = await env.KV.get(aggKey);
  if (!aggRaw) return json({ error: "no results yet" }, 404);
  const agg = JSON.parse(aggRaw);
  if (agg.hanchans_done === 0) return json({ error: "no results yet" }, 404);

  const config: JobConfig = JSON.parse((await env.KV.get(`job:${jobId}:config`))!);
  const players = agg.per_player.map((t: any, i: number) => ({
    player: i,
    avg_rank: Math.round((t.rank_sum / agg.hanchans_done) * 1000) / 1000,
    rank_dist_pct: t.rank_dist.map((c: number) => Math.round(c / agg.hanchans_done * 1000) / 10),
  }));

  return json({
    strategies: config.strategies,
    hanchans_completed: agg.hanchans_done,
    worker: workerFilter ?? "all",
    players,
  });
}

// ─── KV Helpers ────────────────────────────────────────────────────

async function countAssigned(env: Env, jobId: string, total: number): Promise<number> {
  const batches = await getAllBatches(env, jobId);
  const now = Date.now();
  let assigned = 0;
  for (const b of batches) {
    if (b.status === "completed") assigned += b.size;
    else if (b.status === "claimed" && b.claimed_at && (now - b.claimed_at) < CLAIM_TIMEOUT * 1000) {
      assigned += b.size;
    }
  }
  return Math.min(assigned, total);
}

async function countCompleted(env: Env, jobId: string): Promise<number> {
  const batches = await getAllBatches(env, jobId);
  return batches.filter(b => b.status === "completed").length;
}

async function countTotalBatches(env: Env, jobId: string): Promise<number> {
  return (await getAllBatches(env, jobId)).length;
}

async function findOrCreateBatch(
  env: Env, jobId: string, size: number, worker: string,
  assigned: number, total: number
): Promise<number | null> {
  const batches = await getAllBatches(env, jobId);
  const now = Date.now();

  // Reclaim timed-out batch
  for (const b of batches) {
    if (b.status === "claimed" && b.claimed_at && (now - b.claimed_at) > CLAIM_TIMEOUT * 1000) {
      b.status = "claimed";
      b.worker = worker;
      b.claimed_at = now;
      await env.KV.put(`job:${jobId}:batch:${b.id}`, JSON.stringify(b));
      return b.id;
    }
  }

  // Create new batch if room
  const remaining = total - assigned;
  if (remaining <= 0) return null;

  const actualSize = Math.min(size, remaining);
  const newId = batches.length;
  const batch: BatchState = {
    id: newId, size: actualSize, status: "claimed",
    worker, claimed_at: now, completed_at: null, results: null,
  };
  await env.KV.put(`job:${jobId}:batch:${newId}`, JSON.stringify(batch));
  // Update batch index
  const indexKey = `job:${jobId}:batch_ids`;
  const ids: number[] = JSON.parse((await env.KV.get(indexKey)) ?? "[]");
  ids.push(newId);
  await env.KV.put(indexKey, JSON.stringify(ids));
  return newId;
}

async function getAllBatches(env: Env, jobId: string): Promise<BatchState[]> {
  const indexKey = `job:${jobId}:batch_ids`;
  const ids: number[] = JSON.parse((await env.KV.get(indexKey)) ?? "[]");
  const batches: BatchState[] = [];
  for (const id of ids) {
    const raw = await env.KV.get(`job:${jobId}:batch:${id}`);
    if (raw) batches.push(JSON.parse(raw));
  }
  return batches;
}

async function getAllWorkers(env: Env, jobId: string): Promise<WorkerState[]> {
  const list = await env.KV.list({ prefix: `job:${jobId}:worker:` });
  const workers: WorkerState[] = [];
  for (const key of list.keys) {
    const raw = await env.KV.get(key.name);
    if (raw) workers.push(JSON.parse(raw));
  }
  return workers;
}

async function saveWorker(env: Env, jobId: string, ws: WorkerState): Promise<void> {
  await env.KV.put(`job:${jobId}:worker:${ws.name}`, JSON.stringify(ws));
}

async function loadWorker(env: Env, jobId: string, name: string): Promise<WorkerState> {
  const raw = await env.KV.get(`job:${jobId}:worker:${name}`);
  return raw ? JSON.parse(raw) : {
    name, claimed: [], completed: [],
    total_hanchans: 0, total_elapsed: 0, speed_hps: 0, last_seen: 0,
  };
}

// ─── Dashboard ─────────────────────────────────────────────────────

async function serveDashboard(env: Env): Promise<Response> {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mahjong Verify</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:monospace;max-width:900px;margin:0 auto;padding:20px;background:#1a1a2e;color:#eee}
h1{color:#00d4aa}
.bar{background:#333;border-radius:4px;height:24px;margin:8px 0;position:relative}
.bar-fill{background:#00d4aa;height:100%;border-radius:4px;transition:width 0.5s}
.bar-text{position:absolute;left:8px;top:3px;font-size:13px}
table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{padding:6px 10px;text-align:left;border-bottom:1px solid #333}
th{color:#00d4aa}
.stale{color:#666}
#error{color:#f44;display:none}
</style></head><body>
<h1>🀄 Mahjong Verify</h1>
<div id="error"></div>
<div id="content">Loading...</div>
<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
async function refresh() {
  try {
    const r = await fetch('/status');
    if (!r.ok) { document.getElementById('error').textContent='No active job'; document.getElementById('error').style.display='block'; return; }
    const d = await r.json();
    const pct = d.total>0 ? (d.hanchans_done/d.total*100).toFixed(1) : 0;
    const eta = d.eta_seconds ? (d.eta_seconds/60).toFixed(1)+'min' : '?';
    let h = '<div class="bar"><div class="bar-fill" style="width:'+pct+'%"></div><div class="bar-text">'+d.hanchans_done+'/'+d.total+' ('+pct+'%) ETA: '+eta+'</div></div>';
    h += '<table><tr><th>Worker</th><th>Speed</th><th>Done</th><th>Batches</th><th>Last Seen</th></tr>';
    for (const w of d.workers||[]) {
      const cls = w.last_seen_ago > 120 ? 'stale' : '';
      h += '<tr class="'+cls+'"><td>'+w.name+'</td><td>'+(w.speed_hps).toFixed(3)+'/s</td><td>'+w.hanchans_done+'</td><td>'+w.batches_done+'</td><td>'+w.last_seen_ago+'s ago</td></tr>';
    }
    h += '</table>';
    // Aggregate
    const a = await fetch('/aggregate');
    if (a.ok) {
      const ag = await a.json();
      h += '<h3>Rankings ('+ag.hanchans_completed+' hanchans)</h3><table><tr><th>P</th><th>AvgRank</th><th>1位</th><th>2位</th><th>3位</th><th>4位</th></tr>';
      for (const p of ag.players||[]) {
        h += '<tr><td>P'+p.player+'</td><td>'+p.avg_rank+'</td>'+p.rank_dist_pct.map(x=>'<td>'+x+'%</td>').join('')+'</tr>';
      }
      h += '</table><p style="color:#888">Strategies: '+ag.strategies+'</p>';
    }
    // Per-worker rankings
    const activeWorkers = (d.workers||[]).filter(w=>w.hanchans_done>0).map(w=>w.name);
    if (activeWorkers.length > 0) {
      h += '<h3>Per-Worker Rankings</h3>';
      for (const wn of activeWorkers) {
        const wr = await fetch('/aggregate?worker='+encodeURIComponent(wn));
        if (!wr.ok) continue;
        const wa = await wr.json();
        if (!wa.players) continue;
        h += '<details><summary>'+wn+' ('+wa.hanchans_completed+' hanchans)</summary><table><tr><th>P</th><th>AvgRank</th><th>1位</th><th>2位</th><th>3位</th><th>4位</th></tr>';
        for (const p of wa.players) {
          h += '<tr><td>P'+p.player+'</td><td>'+p.avg_rank+'</td>'+p.rank_dist_pct.map(x=>'<td>'+x+'%</td>').join('')+'</tr>';
        }
        h += '</table></details>';
      }
    }
    // All jobs
    const j = await fetch('/jobs');
    if (j.ok) {
      const jd = await j.json();
      h += '<h3>All Jobs</h3><table><tr><th>ID</th><th>Strategies</th><th>Progress</th><th>Status</th><th></th></tr>';
      for (const job of (jd.jobs||[]).reverse()) {
        const pct = job.total>0 ? (job.hanchans_done/job.total*100).toFixed(1)+'%' : '0%';
        const status = job.is_current ? '⚡ active' : (job.hanchans_done>=job.total ? '✅ done' : '⏸ stopped');
        h += '<tr><td>'+job.job_id+'</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+job.strategies+'</td><td>'+job.hanchans_done+'/'+job.total+' ('+pct+')</td><td>'+status+'</td><td><button onclick="viewJob(&#39;'+job.job_id+'&#39;)">View</button></td></tr>';
      }
      h += '</table>';
    }
    // Save open details state
    const openDetails = new Set();
    document.querySelectorAll('details[open]').forEach(d => openDetails.add(d.querySelector('summary')?.textContent));
    document.getElementById('content').innerHTML = h;
    // Restore open details
    document.querySelectorAll('details').forEach(d => {
      if (openDetails.has(d.querySelector('summary')?.textContent)) d.open = true;
    });
    document.getElementById('error').style.display='none';
  } catch(e) { document.getElementById('error').textContent=e; document.getElementById('error').style.display='block'; }
}
let _viewing = null;
refresh(); setInterval(()=>{ if(!_viewing) refresh(); }, 10000);
async function viewJob(id) {
  _viewing = id;
  const r = await fetch('/aggregate?job='+id);
  if (!r.ok) { alert('No results for this job yet'); return; }
  const ag = await r.json();
  let h = '<h3>Job '+id+' ('+ag.hanchans_completed+' hanchans)</h3>';
  h += '<p style="color:#888">'+ag.strategies+'</p>';
  h += '<table><tr><th>P</th><th>AvgRank</th><th>1位</th><th>2位</th><th>3位</th><th>4位</th></tr>';
  for (const p of ag.players||[]) {
    h += '<tr><td>P'+p.player+'</td><td>'+p.avg_rank+'</td>'+p.rank_dist_pct.map(x=>'<td>'+x+'%</td>').join('')+'</tr>';
  }
  h += '</table><button onclick="_viewing=null;refresh()">Back</button>';
  document.getElementById('content').innerHTML = h;
}
</script></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}

// ─── Util ──────────────────────────────────────────────────────────

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
