# AGENTS.md

CNife 的 OMP (Oh My Pi) agent 扩展集合，以 [marketplace](https://github.com/CNife/omp-extensions) 形式组织。结构与 [pi-extensions](https://github.com/CNife/pi-extensions) 类似。

## 结构

```
omp-extensions/
  .omp-plugin/
    marketplace.json          # 插件目录清单
  .githooks/pre-commit        # check:staged
  scripts/                    # check.ts（机械检查）、smoke.ts（扩展加载冒烟）
  plugins/
    nmem/                    # 每个插件一个自包含子目录
      package.json            # omp.extensions + omp.skills 声明
      extensions/             # 扩展入口（.ts 文件）
      skills/                 # 技能（<name>/SKILL.md）
      README.md
  docs/agents/                # 工程技能配置（issue 追踪器、领域文档）
    issue-tracker.md
    domain.md
  docs/adr/
  AGENTS.md
  README.md
  LICENSE
```

## 添加插件

1. 在 `plugins/` 下创建子目录，包含 `package.json`（声明 `omp.extensions` 和 `omp.skills`）、`extensions/`、`skills/` 等。
2. 在 `.omp-plugin/marketplace.json` 的 `plugins` 数组中添加条目。条目需含 `version` 字段（与插件 `package.json` 的 `version` 一致）；**载荷变更**时同步严格递增这两个 version，否则 `omp plugin upgrade`（不带参数）检测不到更新。`bun scripts/check.ts` 会校验这两点。
3. 安装：`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`
4. 升级到新版：`/marketplace update`（catalog 要超过 24 小时才会在启动检查时自动重取，没刷新就用旧 catalog 比对，`omp plugin upgrade` 会报「已是最新」）→ `/marketplace upgrade <name>@omp-extensions` → `/reload-plugins`（当前会话才会重新加载技能）

> 安装副本由 marketplace 分发，不要用 `omp plugin link` / `omp plugin install <本机路径>`（后者同样是链接）把安装副本接到工作树上。本地开发用下方「验证」里的 `-e` 冒烟。

## 验证

```bash
bun install        # 首次：装根 devDeps，并自动把 core.hooksPath 设成 .githooks
bun run check      # bun test + tsc --noEmit + 清单/版本/技能 frontmatter 检查
bun run smoke      # 逐个扩展入口用 `omp --no-extensions -e <entry>` 真加载
```

- pre-commit hook 跑 `check:staged`（版本递增按暂存内容比对）；CI 跑同一个 `check`，并对 PR 额外比对 base。
- 判定冒烟结果看 **stderr 无 `Failed to load extension`** 且命令出现在 `available_commands_update` 里——**omp 加载失败的退出码仍是 0**。为什么不用 `--plugin-dir`（它对插件目录静默不加载）见 [ADR 0005](docs/adr/0005-extension-smoke-load.md)。

## 修改技能时改哪里

`skill://<name>` 解析到的是**安装副本**（`~/.omp/plugins/cache/plugins/omp-extensions___<name>___<version>/`），改它不会进仓、也不会被下次安装保留。改源码一律改 `plugins/<name>/skills/`，改完递增载荷 version 并重装。

## 技能 frontmatter

- `disable-model-invocation: true`：技能不出现在系统提示的技能列表里（模型不能主动触发），但仍可通过 `/skill:<name>` 和 `skill://<name>` 访问。
- 不加此字段的技能模型可主动触发。

## 不进仓

`herdr-omp-agent-state.ts`、`dcg-guard.ts` 等 local-only 文件留在本机 `~/.omp/agent/extensions/`，不迁入本树。

## Agent skills

### Issue tracker

Issues 托管在 GitHub Issues（通过 `gh` CLI 操作）。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文布局：根目录 `GLOSSARY.md` + `docs/adr/`。详见 `docs/agents/domain.md`。
