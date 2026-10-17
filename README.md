# omp-extensions

CNife 的 [OMP](https://omp.dev) (Oh My Pi) agent 扩展集合，以 marketplace 形式组织。

## 安装

### 远程（marketplace）

```bash
/marketplace add CNife/omp-extensions
/marketplace install nmem@omp-extensions
```

### 本地开发

```bash
bun install && bun run check   # 测试 + 类型检查 + 清单/版本/技能检查
bun run smoke                  # 用 `omp -e` 真加载每个扩展入口
```

改源码后用 marketplace 重装（`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`）才会落到安装副本。细节见 [AGENTS.md](AGENTS.md#验证)。

## 插件

| 插件 | 说明 |
| --- | --- |
| [nmem](plugins/nmem/) | nmem 会话自动同步 + opt-in 引导注入，取代官方 nowledge-mem-omp 插件 |
| [skills-injection](plugins/skills-injection/) | 交互式控制哪些技能被注入到系统提示词，持久化配置 |
| [cache-miss-notices](plugins/cache-miss-notices/) | 显著的 prompt-cache miss 即时通知，移植自 pi 的 showCacheMissNotices |
| [howto-skills](plugins/howto-skills/) | how-to 技能合集：browser 提取打法、TTSR 规则编写、加 provider+模型流水线 |
| [plannotator-cli](plugins/plannotator-cli/) | Plannotator 浏览器审阅/标注（CLI shell-out），注入 /pnr /pna /pnl 三命令 |
| [ask-consultants](plugins/ask-consultants/) | /ask-consultants 召集多模型顾问团：并行征询多个模型的独立意见并汇总对比 |

## 添加新插件

1. 在 `plugins/` 下创建子目录，包含 `package.json`、`extensions/`、`skills/` 等。
2. 在 `.omp-plugin/marketplace.json` 中注册。
3. 安装：`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`（不要用 `omp plugin link` / `omp plugin install <本机路径>`，它们会把安装副本换成指向工作树的链接）。
