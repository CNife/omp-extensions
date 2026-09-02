# omp-extensions

CNife 的 OMP agent 插件 marketplace：每个插件是自包含单元，可含运行时扩展与技能。

## Language

### 插件

**仅技能插件**:
package.json 只声明 `omp.skills`、不声明 `omp.extensions` 的插件。允许携带未被注册的 `extensions/` 目录文件（仅由技能经 CLI `--extension` 显式加载的脚本不算扩展）。
_Avoid_: 纯技能插件、skills-only plugin

**扩展插件**:
声明了 `omp.extensions` 的插件，扩展由 omp 在启动时自动注册。
_Avoid_: 代码插件

**howto-skills 插件**:
how-to 技能合集：面向一类任务的操作打法（心智模型 + 执行规范 + 排查）固化为技能。插件名以 `-skills` 结尾标明载体形态。
_Avoid_: playbooks（只说体裁，看不出是技能合集）、primer（primer 只讲概念、不含操作步骤，与实际内容不符）

**playbook**:
预置打法：针对一类场景的心智模型 + 执行规范 + 排查方法的技能。`howto-skills` 插件是此类技能的合集。
_Avoid_: primer（primer 只讲概念、不含操作步骤，与实际内容不符）

**技能名**:
`/skill:` 调用面的稳定标识，取简短的 kebab-case 主题名。
_Avoid_: 带 `omp-` 前缀（marketplace 本身已限定 omp 生态）