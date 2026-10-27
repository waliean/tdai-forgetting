# 参与

## 环境

Node ≥ 22.18。用内置 `node:sqlite` 和 `node --test`，不装数据库驱动、不装测试框架。22.18 是类型擦除默认开启的第一版；更早的 22.x 需要加 `--experimental-strip-types` 才能跑，本仓库不打算为此加兼容层。

```bash
npm install
npm test        # 118 个测试
npm run typecheck
```

TypeScript 由 Node 直接跑（type stripping），`tsc` 只负责类型检查，不产出 JS。所以：

- 不用 enum、namespace、参数属性这类需要编译的语法；
- 相对导入要写扩展名（`./foo.ts`）；
- 别加构建步骤——现在 clone 下来就能跑，这个性质值得保住。

## 改代码前先读

- `docs/design/方案设计-2026-10-26.md`：为什么是分层改造，为什么不用别的方案
- `docs/experiments/实测报告-2026-10-26.md`：哪些结论有数据支撑，哪些是拍的

## 测什么

改打分公式、pin 规则、冗余阈值，请连带更新 `bench/` 里的对照实验，并在 PR 里贴前后数字。理由：这些参数的效果不能靠推理判断，只能测。已有的五个实验覆盖了检索质量、冷启动、过期结论、冗余合并、pin 策略。

改 `src/l1-decay.ts` 必须同时跑 `test/equivalence.test.ts`。这个文件是原样拷进 MemoryCore 的那份，和 `src/scoring.ts` 是两份实现；等价测试是防止它们漂移的唯一手段。

## 数据

不要提交数据库快照、记录正文、三元组 ID。真实语料只用于本地跑 bench，bench 对真实快照只输出聚合数字。

贡献合成语料的改动（`bench/corpus.ts`）时保持固定种子，否则 CI 上的数字会漂。

## 提交

一个 PR 一件事。改公式和改测试分开，方便单独回滚。

commit message 说清"为什么"，不是"改了什么"——diff 已经写了改了什么。
