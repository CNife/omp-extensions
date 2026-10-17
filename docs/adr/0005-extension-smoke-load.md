# 扩展冒烟用 `-e` 加载入口，不用 `--plugin-dir`

`omp --help` 把 `--plugin-dir <path>` 列在 "Plugin Options" 下，但对本仓这种插件目录（含 `package.json` + `omp.extensions`）它**静默不加载**：进程正常启动、退出码 0、stderr 为空，注册的命令一个都没有。实测三种形态（单独用、配 `--no-extensions`、配默认发现）结果一致，omp 18.11.3。

可用的加载路径是 `-e/--extension <入口文件>`：

```bash
omp --no-extensions -e plugins/<name>/extensions/<entry>.ts --mode rpc --no-ui
```

## 考虑过的选项

- **`--plugin-dir`**：语义上最贴切（整个插件目录，含 skills），但当前无效，且失败无声——比报错更糟。
- **`omp plugin install <本机路径>`**：dry-run 显示 `Would link`，会把本机安装副本换成指向工作树的链接，污染用户的安装面（见 AGENTS.md：安装走 marketplace）。
- **`-e <入口文件>`**：只加载扩展入口、不碰安装面；失败时 stderr 打 `Failed to load extension …`。

## 后果

- 冒烟脚本（`scripts/smoke.ts`）以 `-e` 逐插件入口加载，判定条件是 **stdout 有 rpc `ready` + stderr 无 `Failed to load extension` + 源码里 `registerCommand("名字")` 的名字都出现在 `available_commands_update` 里**。
- **不能看退出码**：入口不存在、语法错误、加载时抛异常，omp 三种情况都返回 0。
- `--plugin-dir` 若将来修好，本 ADR 应重估并更新 `scripts/smoke.ts`。
