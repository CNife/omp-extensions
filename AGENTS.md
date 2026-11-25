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
bun run check      # bun test + tsc --noEmit + 清单/版本/技能 frontmatter/注释预算检查
bun run smoke      # 逐个扩展入口用 `omp --no-extensions -e <entry>` 真加载
```

- pre-commit hook 跑 `check:staged`（版本递增按暂存内容比对）；CI 跑同一个 `check`，并对 PR 额外比对 base。
- 注释预算：每文件默认 0 行，新增注释即失败（注释只有删掉或写进 `docs/adr/` 两条路）；删注释后用 `COMMENT_BUDGET_UPDATE=1 bun scripts/check.ts` 收紧 `scripts/comment-budget.json`，预算只降不升。
- 判定冒烟结果看 **stderr 无 `Failed to load extension`** 且命令出现在 `available_commands_update` 里——**omp 加载失败的退出码仍是 0**。为什么不用 `--plugin-dir`（它对插件目录静默不加载）见 [ADR 0005](docs/adr/0005-extension-smoke-load.md)。
- 根 `package.json` 的 `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-tui` devDeps 是对扩展盖章的 API 面，**跟当前 omp 主版本走**：升级 omp 后同步 bump 再跑 `bun run check`，否则 `tsc` 校验的是旧版 API，`DynamicBorder` 这类被删导出的扩展会一直绿到真加载才炸（[ADR 0008](docs/adr/0008-extension-ui-select-checkbox.md)）。
- 冒烟跑的是 **PATH 上的 omp**（脚本剔掉 `node_modules/.bin`）：`bun run` 会把它前置到 PATH，那里有 devDependency 自带的 npm 版 `omp`，跟用户装的 omp 不是同一个东西，拿它冒烟等于验错版本。

## 交付

推送走 no-mistakes 本地门禁：`git push no-mistakes <branch>` 依次跑 rebase → review → test → document → lint → push → PR → CI，任一步不过就不推；合入 PR 必须在门禁通过后由 CNife 批准。

- 门禁命令与测试/文档口径在 `.no-mistakes.yaml`：`prepare` 装依赖，`lint` 跑类型检查与 `scripts/check.ts`，`test` 跑 `bun test`。完整回归（按 base 比对载荷版本）仍由 `.github/workflows/check.yml` 在 PR 上跑。
- 该文件里 `commands` / `test.instructions` / `document.instructions` **只从默认分支读取**，改完要先合进 `main`，否则下一次门禁仍在用旧值。
- 门禁的 gate 与 daemon 在本机 `~/.no-mistakes/`，不进仓；换机器重跑 `no-mistakes init` 即可（`.no-mistakes.yaml` 已被门禁跟踪，无需重新生成）。

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
