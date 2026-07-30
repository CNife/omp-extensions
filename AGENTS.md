# AGENTS.md

CNife 的 OMP (Oh My Pi) agent 扩展集合，以 [marketplace](https://github.com/CNife/omp-extensions) 形式组织。结构与 [pi-extensions](https://github.com/CNife/pi-extensions) 类似。

## 结构

```
omp-extensions/
  .omp-plugin/
    marketplace.json          # 插件目录清单
  plugins/
    nmem-sync/                # 每个插件一个自包含子目录
      package.json            # omp.extensions + omp.skills 声明
      extensions/             # 扩展入口（.ts 文件）
      skills/                 # 技能（<name>/SKILL.md）
      README.md
  docs/agents/                # 工程技能配置（issue 追踪器、领域文档）
    issue-tracker.md
    domain.md
  AGENTS.md
  README.md
  LICENSE
```

## 添加插件

1. 在 `plugins/` 下创建子目录，包含 `package.json`（声明 `omp.extensions` 和 `omp.skills`）、`extensions/`、`skills/` 等。
2. 在 `.omp-plugin/marketplace.json` 的 `plugins` 数组中添加条目。
3. 本机部署：`omp plugin link ./plugins/<name>`
4. 远程安装：`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`

## 技能 frontmatter

- `disable-model-invocation: true`：技能不出现在系统提示的技能列表里（模型不能主动触发），但仍可通过 `/skill:<name>` 和 `skill://<name>` 访问。
- 不加此字段的技能模型可主动触发。

## 不进仓

`herdr-omp-agent-state.ts`、`dcg-guard.ts` 等 local-only 文件留在本机 `~/.omp/agent/extensions/`，不迁入本树。

## Agent skills

### Issue tracker

Issues 托管在 GitHub Issues（通过 `gh` CLI 操作）。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
