# fff

FFF 驱动的模糊文件与内容搜索，移植自 [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff)（`v0.6.0` 精简子集）。

## 工具

- **`fffind`** — 模糊文件名/路径搜索，frecency 排序，git 感知。匹配整条仓库相对路径，多词为 AND。
- **`ffgrep`** — 文件内容搜索，smart-case，自动识别 regex/literal，frecency 排序，分页游标。

两个工具均支持 `path` 约束（`src/`、`*.ts`、`src/**/*.cc`、`{src,lib}/**`，以及工作区外的 `~/`、`../` 绝对路径 via aux finder pool）与 `exclude`（`test/,*.min.js`）。

## 安装

```bash
/marketplace add CNife/omp-extensions
/marketplace install fff@omp-extensions
```

## 配置

可选 `~/.omp/agent/omp-fff.json`（`$schema` 可选）：

```json
{
  "frecencyDbPath": "/path/to/frecency",
  "historyDbPath": "/path/to/history",
  "enableFsRootScanning": false,
  "enableHomeDirScanning": false
}
```

- `frecencyDbPath` / `historyDbPath` — 覆盖 frecency/history LMDB 目录，未配置时优先复用 `fff.nvim` 的数据库（`~/.cache/nvim/fff_nvim` / `~/.local/share/nvim/fff_queries`），否则落到 `~/.omp/agent/fff/{frecency,history}`。
- `enableHomeDirScanning` / `enableFsRootScanning` — 控制 `$HOME` 与 `/` 的扫描，另可用 `FFF_ENABLE_HOME_SCAN=0` 快速关闭。

非法 JSON 或未知字段会直接报错（`Invalid omp-fff config`）。

## 与上游的差异

- 去掉三模式切换、命令系统（`fff-mode/health/rescan`）、`@-mention` 自动补全与 `multi_grep`，仅保留 tools-only。
- 数据目录 `~/.pi/agent` → `~/.omp/agent`（仍兼容 `PI_CODING_AGENT_DIR`），配置文件 `pi-fff.json` → `omp-fff.json`。
- 工具名硬编码为 `fffind` / `ffgrep`，不覆盖 OMP 内置 `find` / `grep`。
- 保留输出格式化（弱匹配采样、frecency/git 注解）、分页游标、aux finder pool、数据库共享等核心能力。
