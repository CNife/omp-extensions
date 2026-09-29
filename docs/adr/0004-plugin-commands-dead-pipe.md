# ask-consultants 不用 manifest commands 声明命令

omp 插件的 `package.json` 支持 `omp.extensions` 之外再声明 `commands` 键指向命令文件，但这条管道目前是死的：`resolvePluginCommandPaths` 没有调用方，命令发现不扫插件根，清单里声明的命令文件不会被加载。因此 `/ask-consultants` 由扩展入口 `registerCommand` 注册，而不是走 manifest commands 声明。

## 考虑过的选项

- **manifest `commands` 声明**：声明式、与 plannotator-cli 等插件的路由方式一致，但运行时根本不读它——声明了也只是躺在清单里。
- **扩展入口 `registerCommand`**：当前唯一真实生效的注册路径，命令与展开逻辑同处一个文件。

## 后果

- 插件的 `package.json` 里没有 `commands` 键；若未来 omp 打通插件命令发现，可把注册迁到声明式，届时删除本 ADR。
- 命令注册依赖 `ExtensionAPI.registerCommand`，该面未文档化但属公开 API，升级宿主时需留意签名变化。
