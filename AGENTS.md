# AGENTS.md

CNife 的 OMP (Oh My Pi) agent 扩展集合。结构与 [pi-extensions](https://github.com/CNife/pi-extensions) 类似，但面向 OMP 运行时。

## 分层

| 目录 | 说明 |
| --- | --- |
| `extensions/` | OMP 扩展（`.ts` 文件），同步到 `~/.omp/agent/extensions/` |
| `skills/` | OMP 技能（`<name>/SKILL.md`），同步到 `~/.omp/agent/skills/` |
| `scripts/` | 同步脚本 |

OMP 扩展是单个 `.ts` 文件，default-export 一个 factory 函数 `function(pi: ExtensionAPI)`。不需要 `package.json`，不需要 npm install。

## 同步

```bash
node scripts/sync.mjs --dry-run   # 预览
node scripts/sync.mjs             # 写入
```

按条目软链到 `~/.omp/agent/`，绝不整树替换。非软链冲突 fail-closed。

## 技能 frontmatter

- `disable-model-invocation: true`：技能不出现在系统提示的技能列表里（模型不能主动触发），但仍可通过 `/skill:<name>` 和 `skill://<name>` 访问。
- 不加此字段的技能模型可主动触发（出现在系统提示技能列表里）。

## 不进仓

`herdr-omp-agent-state.ts`、`dcg-guard.ts` 等 local-only 文件留在本机，不迁入本树。
