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
| [simple-plannotator](plugins/simple-plannotator/) | Plannotator 浏览器审阅/标注，注入 /pnr /pna /pnl 三个斜杠命令 |

## 添加新插件

1. 在 `plugins/` 下创建子目录，包含 `package.json`、`extensions/`、`skills/` 等。
2. 在 `.omp-plugin/marketplace.json` 中注册。
3. 安装：`/marketplace add CNife/omp-extensions` + `/marketplace install <name>@omp-extensions`（**不要用 `omp plugin link`**）。
