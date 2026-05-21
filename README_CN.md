# 麻将 AI — 四人立直麻将模型

基于离线强化学习（Conservative Q-Learning）在顶尖玩家对局记录上训练的竞技立直麻将 AI。

## 模型

**架构：** 1D CNN + Channel Attention
- 192 通道，40 残差块
- 基于 [Mortal](https://github.com/Equim-chan/Mortal) v4 观测编码器
- 多任务学习辅助头

**训练方法：** CQL（Conservative Q-Learning）+ 辅助监督
- 主任务：DQN 动作价值 + CQL 正则化 + 下一局顺位预测
- 辅助头：得点预测、顺位预测（4人）、得点差预测
- 课程学习：先用 ~250 名顶尖玩家训练，再扩展到 ~750 名

**训练数据：**
- 约 138 万局来自约 750 名顶尖四麻玩家的对局记录
- 半荘（东南战）格式，竞技场级别

## 超参数

| 参数 | 值 |
|------|-----|
| conv_channels | 192 |
| num_blocks | 40 |
| batch_size | 256 |
| lr_peak | 1e-4 |
| lr_final | 1e-5 |
| warmup_steps | 200 |
| weight_decay | 0.1 |
| max_grad_norm | 1.0 |
| gamma | 1.0 |
| min_q_weight (CQL) | 5.0 |
| next_rank_weight | 0.2 |
| score_weight | 1.0 |
| rank_weight | 0.5 |
| gap_weight | 0.3 |
| DDP | 2× GPU |

## 性能

4000 局测试（随机坐次，东南战）：

| 模型 | 平均顺位 | 1位率 | 2位率 | 3位率 | 4位率 |
|------|----------|-------|-------|-------|-------|
| **v4（基线）** | **2.419** | 27.3% | 26.2% | 23.7% | 22.8% |
| c3（本模型） | 2.492 | 25.5% | 24.5% | 25.2% | 24.8% |

模型接近但尚未超越 Mortal v4 基线。训练仍在进行中。

## 文件结构

```
weights/                    # 从 Releases 下载
  model-c3-best.pth         # 主模型权重（132MB）
  grp-best.pth              # GRP（对局结果预测器）网络（2.2MB）
scripts/
  train_main.py             # 训练脚本（CQL + 辅助头）
  dataloader.py             # 数据加载器（通过 libriichi 读取 .mjson）
  mortal_bot_server.py      # 推理桥接（连接模型与对局引擎）
  verify_worker_http.sh     # 分布式验证 worker
mahjong/                    # 对局引擎 + AI 控制器（TypeScript）
  src/                      # 引擎源码（游戏逻辑、向听、计分、AI）
  scripts/verify.ts         # 验证编排器
  scripts/verify-worker.ts  # 单 worker 对局执行器
  package.json
cf-verify/                  # Cloudflare Worker 协调器（分布式测试）
```

### 下载权重

从 [Releases](https://github.com/lynkas/c3/releases/tag/v1.0) 下载：

```bash
mkdir -p weights
curl -L -o weights/model-c3-best.pth https://github.com/lynkas/c3/releases/download/v1.0/model-c3-best.pth
curl -L -o weights/grp-best.pth https://github.com/lynkas/c3/releases/download/v1.0/grp-best.pth
```

## 使用方法

### 加载模型进行推理

```python
import torch
import sys
sys.path.insert(0, "path/to/mortal/mortal")
from model import Brain

# 加载权重
ckpt = torch.load("weights/model-c3-best.pth", map_location="cpu")
model = Brain(version=4, conv_channels=192, num_blocks=40)
model.load_state_dict(ckpt["mortal"])
model.eval()
```

### 训练

前置条件：编译好的 Mortal `libriichi`、含 PyTorch 的 Python 虚拟环境、`.mjson` 格式的对局数据。

```bash
# 单 GPU
python scripts/train_main.py \
  --grp checkpoints/grp-best.pth \
  --train-glob "data/train/*.mjson" \
  --val-glob "data/val/*.mjson" \
  --save checkpoints/model.pth \
  --tensorboard runs/experiment \
  --device cuda \
  --conv-channels 192 --num-blocks 40 \
  --batch-size 256 \
  --lr-peak 1e-4 --lr-final 1e-5 \
  --warmup-steps 200 --max-steps 200000 \
  --save-every 400 --val-steps 50 --patience 100 \
  --weight-decay 0.1 --max-grad-norm 1.0 \
  --score-weight 1.0 --rank-weight 0.5 --gap-weight 0.3

# 多 GPU（DDP）
CUDA_VISIBLE_DEVICES=0,1 torchrun --standalone --nproc_per_node=2 scripts/train_main.py \
  [同上参数]
```

**主要参数：**

| 参数 | 说明 |
|------|------|
| `--grp` | GRP 权重路径 |
| `--train-glob` | 训练数据文件 glob 模式 |
| `--val-glob` | 验证数据文件 glob 模式 |
| `--save` | 输出权重路径（同时用于断点续训） |
| `--patience` | 早停耐心值（验证周期数） |
| `--score-weight` | 得点预测辅助 loss 权重 |
| `--rank-weight` | 顺位预测辅助 loss 权重 |
| `--gap-weight` | 得点差预测辅助 loss 权重 |

断点续训：`--save` 指向已有的 checkpoint 即可自动恢复。

### 分布式验证系统

验证系统在多台机器上运行模型对战，由 Cloudflare Worker 协调。

#### 1. 部署协调器

```bash
cd cf-verify
npm install
# 编辑 wrangler.toml，填入你的 account_id、KV namespace 和 token
npx wrangler deploy
```

#### 2. 创建任务

```bash
curl -X POST "https://your-worker.workers.dev/job" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{
    "total": 1000,
    "strategies": "mortal:model-a.pth,mortal:model-b.pth,mortal:model-c.pth,mortal:model-d.pth",
    "difficulties": "0,0,0,0",
    "end_round": 8,
    "shuffle_seats": true
  }'
```

#### 3. 启动 worker

每个 worker 从协调器领取 batch，在本地执行对局，然后上报结果。

```bash
COORDINATOR="https://your-worker.workers.dev" \
TOKEN="YOUR_WORKER_TOKEN" \
WORKER_NAME="my-machine" \
WORKERS=2 \
MODELS_DIR="./weights" \
DEVICE_MAP="cuda:0,cuda:0,cuda:0,cuda:0" \
MAHJONG_DIR="/path/to/mahjong" \
MORTAL_PYTHON="/path/to/venv/bin/python3" \
MORTAL_SERVER="/path/to/mortal_bot_server.py" \
bash scripts/verify_worker_http.sh
```

**Worker 环境变量：**

| 变量 | 必须 | 说明 |
|------|------|------|
| `COORDINATOR` | ✅ | 协调器 URL |
| `TOKEN` | ✅ | Worker 认证 token |
| `WORKER_NAME` | | 在面板上显示的标识名 |
| `WORKERS` | | 并行对局 worker 数（默认 4） |
| `MODELS_DIR` | | 模型 .pth 文件目录 |
| `DEVICE_MAP` | | 每个策略的设备映射（如 `cuda:0,cuda:0,cuda:1,cuda:1`） |
| `MAHJONG_DIR` | | mahjong 项目路径（含 scripts/verify.ts） |
| `MORTAL_PYTHON` | | 含 torch + libriichi 的 Python 解释器 |
| `MORTAL_SERVER` | | mortal_bot_server.py 路径 |

#### 4. 查看进度

- **面板：** 浏览器访问协调器 URL
- **API：**
  ```bash
  curl https://your-worker.workers.dev/status     # 任务进度 + worker 状态
  curl https://your-worker.workers.dev/aggregate  # 总体排名
  curl https://your-worker.workers.dev/aggregate?worker=my-machine  # 单 worker 统计
  ```

#### 5. 管理任务

```bash
# 扩容任务
curl -X PATCH "https://your-worker.workers.dev/job" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -d '{"job_id": "abc123", "total": 4000, "set_current": true}'

# 列出所有任务
curl https://your-worker.workers.dev/jobs
```

## 辅助头

模型使用多任务学习，三个辅助预测头共享 backbone：

1. **ScoreHead** — 预测当前 4 人得点（MSE loss）
2. **RankHead** — 预测 4 人顺位分布（交叉熵）
3. **GapHead** — 预测与第一名/最后一名的 log 尺度得点差（Huber loss）

这些辅助头迫使 backbone 内化对局势的感知（得点位置、顺位动态），这些信息仅靠原始观测编码和策略梯度难以学到。

## 训练流程

模型分阶段训练（课程学习）：

### 阶段 1：基础模型（c）

从 Mortal v4 预训练权重出发，用 CQL 在 ~242 名顶尖玩家数据上微调：

```bash
python scripts/train_main.py \
  --grp checkpoints/grp-best.pth \
  --train-glob "data/top_players_242/*.mjson" \
  --val-glob "data/val/*.mjson" \
  --save checkpoints/model-c.pth \
  --lr-peak 3e-5 --lr-final 1e-6 \
  --weight-decay 0.2 --score-weight 1.0 \
  --rank-weight 0 --gap-weight 0
```

### 阶段 2：扩展数据（c2）

从 model-c 出发，扩展到 ~750 名玩家继续训练：

```bash
cp checkpoints/model-c-best.pth checkpoints/model-c2.pth
python scripts/train_main.py \
  --save checkpoints/model-c2.pth \
  --train-glob "data/top_players_750/*.mjson" \
  --lr-peak 3e-5 --lr-final 1e-6 \
  --weight-decay 0.2 --score-weight 1.0 \
  --rank-weight 0 --gap-weight 0
```

### 阶段 3：添加辅助头（c3）

从 model-c2 出发，添加 rank/gap 预测头，使用更大学习率：

```bash
cp checkpoints/model-c2-best.pth checkpoints/model-c3.pth
python scripts/train_main.py \
  --save checkpoints/model-c3.pth \
  --train-glob "data/top_players_750/*.mjson" \
  --lr-peak 1e-4 --lr-final 1e-5 \
  --weight-decay 0.1 \
  --score-weight 1.0 --rank-weight 0.5 --gap-weight 0.3
```

c3-best 在阶段 3 训练约 14,400 步后取得。

### 数据格式

训练数据使用 `.mjson` 格式（gzip 压缩的 JSON lines），每个文件包含一局对局的 [mjai](https://mjai.app/) 事件格式数据。数据加载器（`scripts/dataloader.py`）通过 `libriichi` 解析。

## 环境要求

- Python 3.10+
- PyTorch 2.0+
- libriichi（Rust 编译的 Python 扩展）
- Node.js + tsx（验证脚本需要）

## 许可证

MIT

模型权重、训练代码和验证工具均以 MIT 许可证发布。

注意：运行时推理环境需要 [Mortal](https://github.com/Equim-chan/Mortal)（AGPL-3.0）组件（libriichi、观测编码器）。本仓库不包含 Mortal 源代码。

## 致谢

基于 Equim 的 [Mortal](https://github.com/Equim-chan/Mortal) 框架构建。
