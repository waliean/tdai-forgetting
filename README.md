# tdai-forgetting

给 [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（tdai）补一套按价值淘汰的遗忘机制：检索层时间衰减、pin 豁免、冗余合并、配额驱动的软删除，全部带审计。

现在不叫"遗忘"，叫"只增不减"。L1 原子记忆一旦写入就不会离开可召回集：唯一的清理器默认关闭，打开也是按 `updated_time` 一刀切——而 dedup 每次合并都会刷新这个字段，所以活得越久的记忆反而越删不掉。

> English summary: policy-based forgetting for tdai — bounded recency/usage re-ranking on the recall path, explicit pin semantics for "remember this forever" memories, duplicate-aware eviction, soft delete with a full audit trail. Numbers are measured, including the cases where the policy loses.

## 为什么这件事值得单开一个仓库

改动落在三处：存储 schema（加列）、检索排序（改打分）、清理策略（新增）。三处都有回滚成本，而 tdai 上游把"基于策略的批量遗忘"明确列为 out of scope。所以先进独立仓库，出补丁、跑数据、拿对照结果，再决定回灌。

代码不复制 upstream，只做两件事：一是给出可以合并进去的补丁（`patches/`，四份），二是把补丁里那个纯函数原样放在 `src/l1-decay.ts`，跑测试的就是将来上线的那个文件。

补丁的验证基线要写清楚：四份补丁在本地检出 `5299c00` 上依次 `git apply` 成功、`build:plugin` 通过、容器内冒烟通过。但那份树已经不是上游现状——在新的上游基线 `084bed45` 上逐份 `git apply --check`，只有纯新增的 0002 能过，0001/0003/0004 全部失败（上游把 `store/sqlite.ts` 重构成了 `store/sqlite/` 目录）。按新布局的重做由画布 `patch-rebase`（R0–R3）承接，本文所有"已验证"都指旧基线。基线的选定依据见 [基线锁定](docs/design/基线锁定-2026-10-27.md)。

补丁验证过程里发现了一个真缺陷：归档只改 `l1_records.state`，`l1_fts` 里的行还在，所以记录归档后仍能被召回。视图挡不住——两条检索路径根本不读视图。修法与实测见 [补丁落地验证](docs/design/补丁落地验证-2026-10-26.md)。

## 快速开始

需要 Node ≥ 22.18（内置 `node:sqlite` 加无标志的 TypeScript 支持；不装任何数据库驱动，也不装构建工具）。22.18 之前的 22.x 会直接报 `ERR_UNKNOWN_FILE_EXTENSION`——类型擦除在那一版才默认开启。

```bash
git clone https://github.com/<owner>/tdai-forgetting
cd tdai-forgetting
npm install
npm test                      # 118 个测试，Node 内置 test runner
```

对着你自己的 tdai 数据库跑（只读，不会写任何东西）：

```bash
# 1. 先看清家底
node src/cli.ts stats --db /path/to/vectors.db

# 2. 出一份遗忘计划，不落库
node src/cli.ts plan  --db /path/to/vectors.db --quota 600 --out plan.json

# 3. 空跑一遍，确认要动多少条
node src/cli.ts apply --db /path/to/vectors.db --plan plan.json --dry-run

# 4. 真要改的时候（建议先拷一份数据库）
node src/cli.ts apply --db /path/to/vectors.db --plan plan.json --notes "first adoption"
```

数据库路径在 tdai 部署里通常是 core 容器的挂载点，例如 `<你的数据目录>/core/vectors.db`。

## 设计要点

### 1. 遗忘先是排序，然后才是删除

检索时给每条命中乘一个系数，范围 `[0.3, 1.5]`：

```
multiplier = clamp( decay + 0.5 * usage , 0.3 , 1.5 )
decay      = 0.3 + 0.7 * 2^(-age / 30d)      # 半衰期，地板 0.3
usage      = 1 - exp(-access_count / 5)      # 边际递减
```

系数最低压到 0.3，不归零也不丢候选——真正能出来的东西不会因为老而消失，只是排序往后。这是 [MemOS](https://github.com/MemTensor/MemOS) 的公式加 [mem0](https://github.com/mem0ai/mem0) 文档里的取值，不是发明。物理删除是另一件事，需要人确认。

### 2. pin 语义不是可选项

线上 822 条记忆里，有 59 条带着 `priority = -1`（上游的"全局指令"约定），另有 162 条指令型记忆正文写着"永久记住 / 不得遗忘"。没有豁免标记的话，任何衰减策略上线第一天就会把它们一起衰减掉。

实现分两级，因为语料里本来就有两种强度的意图：

| 级别 | 触发条件 | 行为 |
|---|---|---|
| hard | `priority = -1`、metadata 显式 pin、指令型记忆断言永久 | 不衰减、不淘汰，检索系数恒为 1.0 |
| extended | 非指令型记录里**引用**了"永久记住" | 衰减，但半衰期 ×12 |

hard pin 的系数是 1.0 而不是 1.5，也不是"从候选池移除"。三种策略都测了（[实验五](docs/experiments/实测报告-2026-10-26.md)）：

| pin 策略 | precision@10 | pin 召回 |
|---|---|---|
| 中性 1.0（采用） | 0.920 | 1.000 |
| 提到上限 1.5 | 0.885 | 1.000 |
| 从候选池移除 | 0.780 | 0.850 |

"永不遗忘"是关于**保留**的承诺，不是关于**排序**的承诺。用户 recall 过二十次的记忆，应该压过一条从没被碰过的 pin。

"引用"和"指令"分开处理也是测出来的：一条 episodic 记录里写着"用户要求 AI 永久记住 X"，那是**请求的记录**，不是请求本身。当成指令会冻结所有提到过"永久"的研究流水账。

### 3. 冷启动时，年龄不是证据

衰减押的注是"新≈有用"。这个前提只在有人记录使用的时候成立。在真实快照上测：

| 条件 | 访问覆盖率 | 强制衰减 | 按门槛 |
|---|---|---|---|
| cold-start | 0% | 0.955 → 0.920 | 0.955 → 0.955（不变） |
| warm-recall | 8% | 0.955 → 0.905 | 0.955 → 0.940 |

（precision@10，embedding 构建的 ground truth，越高越好）

所以默认行为是：访问覆盖率低于 10% 时，年龄项整体退出排序，只保留使用次数。这不是调参，是把一个没有证据支撑的前提关掉。覆盖率一上来，衰减自己就打开了。

### 4. 冗余先于配额

同一件事被不同轮的迁移写了五遍，是这类语料的常态：字面高度相似，dedup 不合并（因为不完全一样），检索时五条一起占坑。

淘汰顺序因此是：pin → 绝对阈值 → 冗余 → 配额。重复副本是最便宜的淘汰对象，先让它付账，配额就不会被迫挤掉独一无二的事实。聚合用 4-gram shingle + Jaccard 单链接，`threshold = 0.6`，不依赖 embedding 服务。

### 5. 软删除 + 审计

"遗忘"= 离开可召回集，不是删字节：

```
state: active | archived | retired | deleted
```

配合 `l1_recallable` 视图，召回路径只在一个地方过滤，不用在五处查询里撒 `state = 'active'`。每次状态变更写一行 `forgetting_audit`（含当时的分数和理由），每次执行写一行 `forgetting_runs`。回滚不改字节，只改 `state`——可执行的那一份是 `scripts/rollback-forgetting.mjs`（按审计指纹判定该恢复哪些行，不用手搓 SQL），方法与演练见[回退演练指南](docs/guides/回退演练-2026-10-26.md)。

## 实测

全部数字来自同一份真实快照（822 条 L1，519 条有向量），ground truth 用 bge-m3 的余弦相似度独立构建，不与被测的两条检索路径共享机制。复现命令见 [docs/experiments](docs/experiments/实测报告-2026-10-26.md)。

### 检索质量

| 配置 | precision@10 | 说明 |
|---|---|---|
| baseline（纯 RRF） | 0.955 | tdai 现状 |
| 衰减（冷启动门槛生效） | 0.955 | 门槛关闭年龄项，等于没改 |
| 强制衰减 | 0.920 | 不看门槛会掉 3.5 个点 |

差距全部来自"年龄被当成无用的证据"。这也意味着：**在接入访问追踪之前，这套改动不会提升检索质量，只会提升可解释性**。这句话应该写在部署说明里，而不是只写在论文里。

### 过期结论

真实快照里没有可修的过期数据——它的近重复是同一天的迁移副本，不是"旧结论被新结论推翻"。所以单开一个受控实验，构造每个事实 90/60/30 天三次复述：

| 配置 | 最新复述排第一 | 窗口内过期副本数 |
|---|---|---|
| baseline | 0.000 | 2.00 |
| 强制衰减 | 1.000 | 2.00 |
| 显式失效标记（对照） | 1.000 | 0.00 |

两件事同时成立：衰减能把最新那条顶上来（0 → 1），但它**不能**把过期副本挤出窗口（仍是 2 条），因为衰减只改排序不改取舍。而一个显式的 `invalid_at` 标记两件事都做到了。

结论写进设计文档：时间衰减是失效标记的**代理**，代理只在时间戳可信时有效。字段能表达的东西，不要用启发式去猜。

## 目录

```
src/                 遗忘引擎（打分 / pin / 冗余 / 计划 / 落库 / 访问日志）
src/l1-decay.ts      原样放进 MemoryCore 的纯函数，测试的就是上线的这份
patches/             回灌 upstream 的四份补丁（在 5299c00 上验证过；上游新布局上 3/4 应用不了，重做见画布 patch-rebase）
bench/               对照实验（合成语料、真实快照、受控过期语料）
test/                118 个测试，node --test
docs/research/       业界遗忘机制调研
docs/design/         缺口诊断与方案设计
docs/experiments/    实测报告
```

## 边界与已知问题

- **补丁的目标树已不是上游现状。** 0001/0003/0004 在基线 `084bed45` 上 `git apply --check` 全部失败，只有纯新增的 0002 能应用；本地检出 `5299c00` 落后 47 个提交，上游已把 `store/sqlite.ts` 重构成 `store/sqlite/` 目录。**没有任何补丁能上生产**：补丁只在旧基线上验证通过，按新布局的重做由画布 `patch-rebase`（R0–R3）承接；基线已锁定（`084bed45`，与生产镜像逐字节相同），证据见 [基线锁定](docs/design/基线锁定-2026-10-27.md)。

  版本号不能用来判断代码代数：`v2.0.0` / `v2.0.0-beta.1` / `v2.0.1*` 的 `package.json` 写 `2.0.0-beta.1` 且有文件 `store/sqlite.ts`；`v2.0.2` / `v2.0.2-beta.1..3` / `v2.0.3-beta.1` **全写 `1.0.2-beta.1`** 且是目录 `store/sqlite/`。生产镜像（`5b6b71fe`，`1.0.2-beta.1`）是更新的重构后代。只看文件布局。
- **0003 是死代码。** 补丁进了镜像，但 `v2-router.ts`（`:1210`）/ `tdai-core.ts`（`:439`）调 `executeMemorySearch` 时都不传 `decay`，而 `memory-search.ts` 的重排只在 `if (decay)` 里跑；A4 容器日志里 `[decay]` 命中 **0 次**（那份日志已随容器删除，这条只能当当时的观察记录）。衰减从未被执行过——四层机制里"检索排序"那一层目前在真实容器里等于不存在。接线是 R3 的事。**可复算的代码依据与行号见[补丁落地验证](docs/design/补丁落地验证-2026-10-26.md) 8.10 末段。**
- **orphan warn 会随归档率刷屏。** 归档记录被向量路径命中时打一条 `[L1-search] record_id=… has vector but NO metadata (orphan)`：这是 0004 生效的直接证据（查视图查不到 → 走跳过分支），但量级取决于归档率，生产开这套补丁后会持续刷。建议降到 debug 或按 record_id 采样，代码没改。
- **容器持库时宿主机就地 UPDATE 会静默写坏索引。** 症状是"归档没生效"而不是"数据库坏了"：`UPDATE` 返回 `changes:1`、按主键单查也对，但 `SELECT COUNT(*) FROM l1_recallable` 仍返回归档行，`integrity_check` 报 `row 696 missing from index idx_l1_state`，而 `quick_check` 报 ok。正确流程是**停容器 → 改库 → `PRAGMA wal_checkpoint(TRUNCATE)` → 起容器**，写完复查 `integrity_check` 与"索引 COUNT == 全表扫 COUNT"。见[补丁落地验证](docs/design/补丁落地验证-2026-10-26.md)第八节 8.7。
- **容器内冒烟已做**（A4，通过 REV-001）。临时容器指向 `VACUUM INTO` 副本、换端口 8421、6.3 秒 healthy，`/v3/atomic/search` 返回 5 条，把排第一的记录归档后同一 query 仍 5 条且不含该 id（候选窗口回填到满），`docker logs` 里 error 级 0 条。证据与逐项数字在[补丁落地验证](docs/design/补丁落地验证-2026-10-26.md)第八节。
- **回退演练只覆盖补丁树**。[回退演练指南](docs/guides/回退演练-2026-10-26.md) 记录了两遍副本上的完整回退：停容器 → 改库 → checkpoint → 起容器，从停容器到召回返回 **6.5 秒 / 13.9 秒**（验收线 300 秒，差异几乎全在容器起停），52 条归档记录全部恢复、同一 query 的召回逐条与归档前一致，"不改历史审计、不删列"也都实测过。回退逻辑是 `scripts/rollback-forgetting.mjs`（带指纹判定，不是文档里的 SQL 片段）。但演练用的是打过补丁的那棵树，生产在跑的是目录式 `store/sqlite/` 那一代代码——**这不等于"回退已验证"**，上线前需要同口径再演一次。
- **没有自动调度**。第一版故意只提供命令，不提供定时任务。阈值应该先被人工审几轮再自动化。
- **访问追踪需要改检索路径**。目前提供 append-only 日志 + 离线折叠（`src/recall.ts`），接进 gateway 的补丁没做——四份补丁里不包含它。
- **只处理 L1**。L0 对话、L2 场景、L3 画像的淘汰策略不同，不在本次范围。
- **shingle 相似度对长文本偏保守**。几百字以上的记录做 4-gram 比较会稀释相似度，阈值可能需要按长度分档。
- **冷启动门槛 10% 是拍的**，只在两三份语料上验证过，样本不够。

## 上游状态

tdai 的 issue 里有一条人工遗忘命令（`/tdai-memory-forget`，带预览和确认），明确把两件事排除在外：

> - 修改 MemoryCore 删除语义
> - Bulk / policy-based forgetting (that's a separate design)

也就是说，单条人工删除上游在做，基于策略的自动遗忘没做也没排期。这个仓库填的是后面那个空。

## 许可

MIT。引入的算法参考与许可证情况见 [业界遗忘机制调研](docs/research/业界遗忘机制调研-2026-10-26.md)（mem0 / MemOS / MemoryBear / Graphiti / MemoryOS 均为 Apache-2.0，公式与架构层面的移植无许可证障碍）。
