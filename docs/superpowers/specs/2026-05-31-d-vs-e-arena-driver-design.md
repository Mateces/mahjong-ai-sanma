# d vs e 三麻 arena driver — 设计文档

日期：2026-05-31  
作者：cat + claude  
状态：草稿，待用户审阅

## 目标

在 d 和 e 两个 sanma checkpoint 之间跑双向对战（A 表 = 1×d + 2×e；B 表 = 1×e + 2×d），共 6 个 worker 并行（本地 Mac 2 个 + stallion 4 个），每场 hanchan 实时把局级指标上报到 report center（rpc.moki.cat），事后从 report center 拉数据做聚合分析。

## 模型

| 名称 | 路径 | step | 形状 |
|---|---|---|---|
| d | `~/mahjong-ai-sanma/checkpoints/sanma-main-best.pth.d` | 122000 | v5, conv=192, blocks=40, obs (780, 34), ACTION_SPACE=44 |
| e | `~/mahjong-ai-sanma/checkpoints/sanma-main-best.pth` | 191200 | v5, conv=192, blocks=40, obs (780, 34), ACTION_SPACE=44 |

两个 ckpt 网络结构完全一致，可直接互相用作 OneVsTwo 的 challenger / champion，不需要兼容层。

## 架构

```
                     ┌─────────────────────────────────┐
                     │  rpc.moki.cat  (report center)  │
                     └─────────────────────────────────┘
                              ▲             ▲
                  POST /api/events/batch    │
                              │             │
   ┌───────── local Mac ──────┴────┐  ┌─────┴─── stallion ───────┐
   │ worker L0  table A (1d+2e)    │  │ worker S0  table B (1e+2d)│
   │ worker L1  table B (1e+2d)    │  │ worker S1  table A (1d+2e)│
   │   2 × CPU                     │  │ worker S2  table B (1e+2d)│
   └───────────────────────────────┘  │ worker S3  table A (1d+2e)│
                                      │   4 × GPU                 │
                                      └───────────────────────────┘

         ┌──────────────────────────────────────────────┐
         │  arena_battle.py  (existing — minor changes) │
         │   - 多 worker、独立 seed stripe              │
         │   - OneVsTwo.py_vs_py_detailed               │
         │   - 批量 RPC 上报                            │
         │   - + 调用 per_game_stats.parse_mjai()        │
         │   - + 把局级指标塞进 hanchan event           │
         └──────────────────────────────────────────────┘
                              │
                              ▼
         ┌──────────────────────────────────────────────┐
         │  per_game_stats.py  (NEW)                    │
         │   parse_mjai(jsonl_path) →                   │
         │     {seat: {agari_kyoku: int, riichi_kyoku,  │
         │             fuuro_kyoku, houjuu_kyoku,       │
         │             tsumo_agari, ron_agari,          │
         │             score_delta_kyoku: [...],        │
         │             kyoku_count}}                    │
         └──────────────────────────────────────────────┘
```

## 现有代码现状

`scripts/arena_battle.py` 已存在并工作，提供：

- 多 worker 模式：`--workers N --worker-id i`，seed stripe `[base + (round*N + i)*batch, ...)` 互不重叠。
- `OneVsTwo.py_vs_py_detailed(seed_count=batch_seeds)` 拿到逐场记录 `(seed, key, split_idx, names, scores, ranks, challenger_seat)`。
- mjai 日志写盘（`<log_dir>/<seed>_<key>_<a|b|c>.json.gz`，三个 split 对应 challenger 坐 0/1/2）。
- `worker.online` / `worker.heartbeat` / `worker.error` / `worker.stopped` 生命周期事件。
- 单条 hanchan event 通过 `make_hanchan_event` 组装，批量 POST `/api/events/batch`（≤ 50/批）。
- 5 次指数退避，network 失败抛 RuntimeError 终止 worker（这里要按"不阻塞对战"的原则改弱）。

我们不重写它。本设计就是：

1. 新增 `scripts/per_game_stats.py`（解析单局 mjai 算指标）。
2. 改造 `arena_battle.py` 的 `make_hanchan_event`：跑完一批 OneVsTwo 后，按 `<seed>_<key>_<a|b|c>.json.gz` 路径打开对应 mjai 日志，喂给 `parse_mjai`，把每个 seat 的局级指标连同 model 身份、score、rank 一并塞进 event.data。
3. 改造 `rpc_send_with_retry`：上报失败 → stderr 警告 + 落盘 `<log_dir>/<host>-w<id>-missed.jsonl`，**不抛**（不阻塞对战）。麻将引擎 / mjai 解析任何异常仍然直接 raise 终止 worker。

## 核心数据结构

### OneVsTwo 输出（已验证）

每个 record 是 7 元组：
- `seed`: int
- `key`: int（u64）
- `split_idx`: int ∈ {0,1,2}（challenger 坐 a/b/c）
- `names`: list[str]，长 3，全是 engine.name（不能从这里推 model 身份）
- `scores`: list[int]，长 3，按 table seat 索引（0/1/2 对应该 hanchan 第 1/2/3 局起庄）
- `ranks`: bytes，3 字节，0-based（0=1 位，1=2 位，2=3 位）
- `challenger_seat`: int ∈ {0,1,2}

### 本设计的"模型身份" 推导

知道 `table` 和 `challenger_seat`：
- table A（1×d + 2×e）：`model[challenger_seat]="d"`，其他两个 seat 为 "e"。
- table B（1×e + 2×d）：`model[challenger_seat]="e"`，其他两个 seat 为 "d"。

### per-seat 指标（kyoku-level）

`parse_mjai(jsonl_path)` 返回字典 `{0|1|2: SeatStats}`，其中 SeatStats：

```python
{
    "kyoku_count": int,         # 该 seat 经历的 kyoku 数（= 整个 hanchan 的 kyoku 总数，三个 seat 都一样）
    "agari_kyoku": int,          # actor==seat 的 hora 事件所在 kyoku 数（一个 kyoku 对该 seat 至多算一次和牌）
    "tsumo_agari_kyoku": int,    # hora.actor==seat 且 hora.target==seat
    "ron_agari_kyoku": int,      # hora.actor==seat 且 hora.target!=seat
    "riichi_kyoku": int,         # 该 seat 立直的 kyoku 数
    "fuuro_kyoku": int,          # 该 seat 发生 chi/pon/daiminkan/kakan 任一的 kyoku 数；ankan、nukidora 都不计
    "houjuu_kyoku": int,         # hora.target==seat 且 hora.actor!=seat 的 kyoku 数
    "ryukyoku_kyoku": int,       # 该 kyoku 以 ryukyoku 结束（每个 seat 都计 1）
}
```

"一位率 / 二位率 / 三位率"是 hanchan 级（不是 kyoku 级），分母 = hanchan 总场数（每个 seat 6000），分子 = 该 model 取得 1/2/3 位的 hanchan 数。直接从每条 event 的 `ranks` 字段聚合即可，不进 SeatStats。

注意：

- 一个 kyoku 内可能出现"双响"（一发ron 两人和），但本仓库 sanma libriichi 实测每个 kyoku 至多一个 hora 事件（也最多一个 ryukyoku）。如果实际遇到两个 hora，按 distinct kyoku 内累计。解析器以 kyoku 为单位累积布尔标志再扁平化，确保"每 kyoku 至多 +1"。
- "副露率"严格按用户定义：`chi | pon | daiminkan | kakan` 四种 actor 端事件 → 该 seat 该 kyoku 副露=True；`ankan`（暗杠）和 `nukidora`（拔北）都**不算**。
- 流局率分母 = kyoku 总数（三个 seat 共用），分子 = 该 seat 经历的流局 kyoku 数（必然等于 hanchan 流局 kyoku 数，因为三人都在场）。
- "放铳"严格按 `hora.target==seat 且 actor!=seat`。tsumo 时 deltas 让其他 seat 也是负值（贡献ツモ点），但 target==actor 不算放铳。
- score 守恒：起手 35000×3 = 105000。hanchan 末尾 `sum(scores)` 必须等于 105000（立直棒在终局会清算给 1 位）。`parse_mjai` 在 end_game 时断言这一点，差任何点都 raise。

### Hanchan event payload

```json
{
  "source": "sanma-arena-d-vs-e-tableA-2026-05-31",
  "type": "arena.hanchan",
  "status": "success",
  "severity": "info",
  "skip_notify": true,
  "timeout_ms": 600000,
  "message": "seed=99001 split=0 chal_seat=0 score=24350 rank=3",
  "data": {
    "run_id": "d-vs-e-tableA-2026-05-31",
    "table": "A",
    "worker_id": 0,
    "host": "stallion",
    "seed": 99001,
    "key": 12648430,
    "split": 0,
    "challenger_seat": 0,
    "scores": [24350, 39300, 41350],
    "ranks": [3, 2, 1],
    "kyoku_count": 6,
    "seats": [
      {"seat":0,"model":"d","score":24350,"rank":3,
       "agari":1,"tsumo_agari":1,"ron_agari":0,
       "riichi":2,"fuuro":0,"houjuu":1,"ryukyoku":1},
      {"seat":1,"model":"e","score":39300,"rank":2,...},
      {"seat":2,"model":"e","score":41350,"rank":1,...}
    ]
  }
}
```

每个 seat 的 7 项 kyoku-level 计数 + score + rank + model。事后从 `GET /api/events?source=...` 拉全量做跨场聚合：和牌率 = sum(agari) / sum(kyoku_count)（按 model 分桶），其余四项同理。

## seed 调度

复用 arena_battle.py 现有逻辑：`stripe = round_idx * workers + worker_id`，`seed_start = seed_base + stripe * batch_seeds`。两个表（A、B）各有自己的 `--run-id`、自己的 source、自己的 6-worker stripe 空间，互不重叠。每个 worker 都用 `--workers 6` 与一个全局 `worker_id ∈ [0, 6)`。

具体分配：

| Worker | 主机 | 表 | run-id（也是 source 后缀） | worker-id | seed-base | seed-key |
|---|---|---|---|---|---|---|
| L0 | mac | A | `d-vs-e-A-20260531` | 0 | 0xA0_0000 | 0xC0FFEE |
| L1 | mac | B | `d-vs-e-B-20260531` | 0 | 0xB0_0000 | 0xC0FFEE |
| S0 | stallion | A | `d-vs-e-A-20260531` | 1 | 0xA0_0000 | 0xC0FFEE |
| S1 | stallion | B | `d-vs-e-B-20260531` | 1 | 0xB0_0000 | 0xC0FFEE |
| S2 | stallion | A | `d-vs-e-A-20260531` | 2 | 0xA0_0000 | 0xC0FFEE |
| S3 | stallion | B | `d-vs-e-B-20260531` | 2 | 0xB0_0000 | 0xC0FFEE |

注意：A 表 3 个 worker（id=0,1,2），B 表 3 个 worker（id=0,1,2），各自独立 stripe；两表不共享 worker_id 空间。`--workers` 仍传 3（不是 6），因为 stripe 是表内的。

每个表跑 2000 seed → 6000 hanchan，总共 12000 hanchan。`batch_seeds=10` → 每 worker 跑 ~667 seed。

## 错误处理

| 错误类别 | 处理 |
|---|---|
| Rust panic / OneVsTwo 异常 | worker 进程退出非零，`finally` 块发 `worker.error` event + `POST /api/sources/<source>/fail`，traceback 末尾 4KB 进 reason。 |
| ckpt 加载失败 / 网络下载失败 / 缺文件 | 启动期 raise，进程崩。 |
| `parse_mjai` 内部异常（事件类型未知、score 不守恒、actor 越界、kyoku 计数不一致等） | raise，worker 终止。**严禁 try/except: pass**。 |
| RPC POST 失败（5 次退避后） | stderr 警告 + 写 `<log_dir>/<host>-w<id>-missed.jsonl`（每行一个完整 event payload）+ 继续跑下一场。**绝不阻塞对战**。 |
| worker.online / worker.heartbeat / worker.stopped POST 失败 | 同上，写 missed 文件，不抛。 |

补发：跑完后人工 `python scripts/replay_missed.py <missed.jsonl>`，最简实现就是逐行 POST。worker 端不做幂等。

## 测试

### 前置 smoke（已完成）

✅ 在 stallion 上裸调 `OneVsTwo.py_vs_py_detailed(seed_count=1)`，确认 record 是 7 元组、`ranks` 是 3 字节 bytes、mjai jsonl 落到 `<log_dir>/<seed>_<key>_<a|b|c>.json.gz`，三个 split 各对应 challenger 坐 0/1/2。

### 单元测试 `tests/test_per_game_stats.py`（新）

用 fixture jsonl（手工裁剪自 smoke 数据）覆盖：

1. **自摸和** — `hora.actor==target==0`：seat0 `agari=1, tsumo_agari=1, ron_agari=0, houjuu=0`；其他两个 seat `agari=0, houjuu=0`。
2. **荣和** — `hora.actor=2, target=0`：seat2 `agari=1, ron_agari=1`；seat0 `houjuu=1`；seat1 全 0。
3. **流局** — kyoku 以 `ryukyoku` 收尾：三个 seat 都 `ryukyoku_kyoku=1`，agari/houjuu 全 0。
4. **副露语义** — kyoku 内出现 `pon{actor=1}` + `nukidora{actor=1}` + `ankan{actor=1}` → seat1 `fuuro_kyoku=1`（pon 算，ankan 和 kita 都不算）。再加一个 kyoku 只有 `ankan{actor=1}` + `nukidora{actor=1}` 没别的 → seat1 `fuuro_kyoku=0`。`chi/pon/daiminkan/kakan` 四种事件都有正例，`ankan/nukidora` 各有反例。
5. **多 kyoku 累积** — 一个 hanchan 6 kyoku，seat 0 在 kyoku 1 立直、kyoku 3 副露、kyoku 5 和牌：`riichi_kyoku=1, fuuro_kyoku=1, agari_kyoku=1, kyoku_count=6`。
6. **未知事件 type** — 注入一个不在白名单的 event → raise（不静默吞）。
7. **score 守恒** — 末尾 deltas 加合不为 105000 → raise。
8. **double agari 检查** — 同一 kyoku 两次 hora.actor==seat → 累 `agari_kyoku += 1` 但不超过 1（用 kyoku 内 set 兜底）。

### RPC 联通 smoke

`source = sanma-arena-smoke-test`，挂 `auto_hide=30`，POST 一条 `arena.hanchan` 模拟 event，GET 回字段对齐，DELETE source。

### 集成 smoke

stallion 上单 worker 跑 `--max-rounds=1 --batch-seeds=2 --run-id=d-vs-e-smoke-test --source-suffix=-smoke`，预期上报 6 条 `arena.hanchan` + 1 条 `worker.online` + 1 条 `worker.heartbeat` + 1 条 `worker.stopped`。验证 dashboard 进度条更新、kyoku-level 计数有非零值。完事 `DELETE /api/sources/sanma-arena-d-vs-e-smoke-test`。

### canary

每表 1 个 worker（共 2 worker）跑 `--max-rounds=5 --batch-seeds=10` = 50 seed × 3 split = 150 hanchan/表。看 ~10 分钟，确认无 worker.error，停掉，检查 missed.jsonl 是否为空。OK 后启全量 6 worker。

### 完赛核对

人工：

- `GET /api/events?source=sanma-arena-d-vs-e-A-20260531&limit=500&cursor=...` 翻页拉全部，按 type 分桶计数，`arena.hanchan` 应得 6000 条。
- 写 `scripts/aggregate_arena.py`（~80 行）按 model（d / e）分桶，对每项指标算 sum / kyoku_count + 二项分布 95% Wilson 置信区间。

## 实施顺序

1. `scripts/per_game_stats.py` + `tests/test_per_game_stats.py`（TDD，先失败再实现）。
2. 改 `arena_battle.py`：
   - `rpc_send_with_retry` 改为非抛模式，落盘 missed。
   - `make_hanchan_event` 接受 `seat_stats` 参数。
   - 主循环：跑完一批后按 record 路径打开 mjai.gz、parse、合并。
   - 加 `--table A|B`（决定 model 身份字符串），加 `--challenger-model d|e --champion-model d|e`（双向运行时方便外部脚本拼参数）。
3. `scripts/replay_missed.py`（最简，~30 行）。
4. 联通 + 集成 smoke。
5. canary。
6. 全量启动（写一份 `scripts/launch_arena.sh` 备记 6 条命令）。

## 不在范围内

- u（Akagi bot_3p）的接入。已确认本轮不做。
- 服务端聚合（complete event 触发等）。事后人工 `aggregate_arena.py` 即可。
- 跨 hanchan / 跨 worker 增量聚合上报。当前 `worker.heartbeat` 已有 round-level 概要，足够监控。
- 多机调度框架。靠人手启 6 条命令，简单可控。
