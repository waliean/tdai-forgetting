# C6 判据评测的可复算材料

这个目录是 `docs/experiments/LLM判据实测-2026-11-04.md` §6.5 与 §8 的物证。它存在的理由是评审的一句话：一份只贴结论的误差报告，第三方没法照着跑出同一个数。

## 为什么不放记忆正文

仓库是公开的，L1 记忆库是个人的真实数据。所以这里**只有 id 与标签，没有正文**：

- `review-set.json` —— 50 个 pairId（`oldId__newId`），加上抽样规则与种子。没有正文。
- `human-labels.json` / `blind-labels.json` —— 两位标注者的判决与一句话理由。理由说的是**关系类型**（「同一备份事件的两次记录」），不引原句。
- `evaluation.json` / `agreement.json` —— 混淆矩阵、误标率、κ。

要重跑机器侧那一步（judge 实际读正文），需要一份 `vectors.db` 副本。那是 `data/snapshot-20261026.db`，不进版本库（`.gitignore` 里 `data/` 与 `*.db`）。也就是说：**标签部分任何人都能查，机器侧那一步需要拿到同一份库**。这是公开仓库做记忆评测绕不过去的一步，写在这里而不是装作没有。

## 文件

| 文件 | 作用 |
|---|---|
| `review-set.json` | 50 对，抽样规则 band `[0.10, 0.90]` + seed `20261026` |
| `human-labels.json` | A1（实现者）标注 |
| `blind-labels.json` | A2（盲标，独立子代理，未看过 A1 与文档）标注 |
| `stub-judge.mjs` | 离线 OpenAI 兼容 stub judge，按 pairId 排序后的**稳定下标**判决 |
| `merge-labels.mjs` | 把 A1 标签并进 review set，产出带 `humanVerdict` 的集合（输出目录由 argv 给） |
| `report-to-verdicts.mjs` | criteria 运行报告 → `criteria-eval --verdicts` 输入 |
| `agreement.mjs` | 一致率、Cohen's κ、三套误标率 |
| `census.mjs` | 数 `invalid_at` 非空行与审计表按 action 分组的行数 |
| `regen.ps1` | 一条命令跑完全部实测（七个场景 + census + 报告摘要 + 误标率 + κ） |
| `evaluation.json` / `agreement.json` | 当前结果 |

## 结论摘要

| 金标准 | 误标率 |
|---|---|
| A1（实现者，AI） | 70.6%（12/17） |
| A2（盲标，独立 AI） | 88.2%（15/17） |
| 两者共识的 36 对 | 85.7%（12/14） |

两位标注者一致率 72.0%（36/50），Cohen's κ = **0.268**。

三个误标率都远高于 5% 门槛，所以门禁会拒绝 apply —— 这是它该做的。但真正该读的是 κ = 0.268：**连「两条记忆是否构成取代」这个判断本身，两个独立判断者有四分之一对不上**。5% 的绝对阈值在这份语料上不可测量。

两位标注者都是 AI 代理。A2 没看过 A1 的答案，但与 A1 是同一底层模型，所以 72% 不能外推为人类标注者之间的一致性。

## 复现

```powershell
cd E:\tdai-forgetting
& docs\experiments\c6-criteria-eval\regen.ps1
```

需要先有 `data/snapshot-20261026.db`（副本由脚本自己复制，原件只读）。换输出目录用 `-Work`。

本机只有 Windows PowerShell 5.1，没有 `pwsh`；脚本在 5.1 下跑通。

分步命令见 `docs/experiments/LLM判据实测-2026-11-04.md` §8。

## 设计约束（刻意的）

- **`regen.ps1` 不写本目录。** 所有产物落 `-Work`，默认 `.scratch/c6-lead/`。一个会覆盖自己证据的验收脚本没有意义。
- **`agreement.mjs` 不给 `--out` 就不落盘。** 同理。
- **`stub-judge.mjs` 按 pairId 排序后的下标判决，不按请求顺序。** 每个 CLI run 都是新进程，按请求序号判决会让两次 run 判不同的对（旧版实测交集 0/17）。
- **`review-set.json` 不含正文。** 公开仓库不放个人记忆内容。
