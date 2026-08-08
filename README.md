# omp-extensions

CNife 的 [OMP](https://omp.dev) (Oh My Pi) agent 扩展集合，以 marketplace 形式组织。

## 安装

### 远程（marketplace）

```bash
/marketplace add CNife/omp-extensions
/marketplace install nmem-sync@omp-extensions
```

### 本地开发

改源码后重新安装即可（命令同上）：

```bash
/marketplace add CNife/omp-extensions
/marketplace install <name>@omp-extensions
```

## 插件

| 插件 | 说明 |
| --- | --- |
| [nmem-sync](plugins/nmem-sync/) | nmem 会话自动同步 + 引导注入，取代官方 nowledge-mem-omp 插件 |
| [prune-context](plugins/prune-context/) | 确定性上下文裁剪：零 LLM 开销的 prune->format 管线替代 LLM 摘要压缩 |
| [skills-injection](plugins/skills-injection/) | 交互式控制哪些技能被注入到系统提示词，持久化配置 |
| [cache-miss-notices](plugins/cache-miss-notices/) | 显著的 prompt-cache miss 即时通知，移植自 pi 的 showCacheMissNotices |
| [add-provider-models](plugins/add-provider-models/) | omp 加 provider+模型技能 + capture 验证扩展 |

## 添加新插件

1. 在 `plugins/` 下创建子目录，包含 `package.json`、`extensions/`、`skills/` 等。
2. 在 `.omp-plugin/marketplace.json` 中注册。
3. 安装：`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`（**不要用 `omp plugin link`**）。
