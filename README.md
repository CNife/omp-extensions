# omp-extensions

CNife 的 [OMP](https://omp.dev) (Oh My Pi) agent 扩展集合。

## 结构

| 目录 | 说明 |
| --- | --- |
| `extensions/` | OMP 扩展（`.ts` 文件），同步到 `~/.omp/agent/extensions/` |
| `skills/` | OMP 技能（`<name>/SKILL.md`），同步到 `~/.omp/agent/skills/` |
| `scripts/` | 同步脚本 |

## 同步

```bash
# 预览
node scripts/sync.mjs --dry-run

# 写入本机（按条目软链，绝不整树替换）
node scripts/sync.mjs
```

脚本按**条目**软链到 `~/.omp/agent/`：

| 条目类型 | 判定 | 动作 |
| --- | --- | --- |
| 扩展 | `extensions/*.ts` | 软链文件到 `~/.omp/agent/extensions/` |
| 技能 | `skills/<name>/SKILL.md` | 软链目录到 `~/.omp/agent/skills/` |

### 幂等与冲突

- 重复运行安全：已指向正确源的软链不动。
- 目标已存在且**不是**软链 -> **失败并提示**，避免覆盖 herdr、dcg-guard 等 local-only 文件。

## 不进仓（local-only 边界）

以下留在本机扩展目录，**不要**迁入本树：

- `herdr-omp-agent-state.ts`（由 herdr 维护）
- `dcg-guard.ts`（由 DCG 维护）
- 密钥、会话数据

## 当前内容

| 条目 | 类型 | 说明 |
| --- | --- | --- |
| `nmem-sync.ts` | 扩展 | nmem 会话自动同步 + 引导注入，取代官方 nowledge-mem-omp 插件 |
| `distill-memory` | 技能 | 保存记忆（模型可主动触发） |
| `search-memory` | 技能 | 搜索记忆（模型可主动触发） |
| `read-working-memory` | 技能 | 读取 Working Memory（`disable-model-invocation`） |
| `save-thread` | 技能 | 保存会话 handoff（`disable-model-invocation`） |
| `status` | 技能 | 检查 nmem 后端连通性（`disable-model-invocation`） |
