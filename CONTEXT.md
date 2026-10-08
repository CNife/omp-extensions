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

**退役**:
插件的终态：从 marketplace 摘除注册并删除插件目录，代码只留在 git 历史与 ADR 里。
_Avoid_: 下架（可能仍可安装）、废弃 / deprecated（可能仍在仓里）、删除（只说了动作，没说明注册面一起摘）

**howto-skills 插件**:
how-to 技能合集：面向一类任务的操作打法（心智模型 + 执行规范 + 排查）固化为技能。插件名以 `-skills` 结尾标明载体形态。
_Avoid_: playbooks（只说体裁，看不出是技能合集）、primer（primer 只讲概念、不含操作步骤，与实际内容不符）

**playbook**:
预置打法：针对一类场景的心智模型 + 执行规范 + 排查方法的技能。`howto-skills` 插件是此类技能的合集。
_Avoid_: primer（primer 只讲概念、不含操作步骤，与实际内容不符）

**技能名**:
`/skill:` 调用面的稳定标识，取简短的 kebab-case 主题名。
_Avoid_: 带 `omp-` 前缀（marketplace 本身已限定 omp 生态）

### 技能注入

**not installed**:
skills-injection 中技能相对当前会话的一种状态：配置里登记过该技能，但当前会话未加载它。区别于"已加载、但按配置不注入"（forbidden）。
_Avoid_: not in context（与 forbidden 撞义——被排除的技能同样不在系统提示词里）

### 任务

**长任务**:
预期耗时超过一次前台等待、或需要活过 omp 退出的工作单元；`long-running-tasks` 技能以它为主题。
_Avoid_: 后台任务（后台只是它的一种归宿）、异步任务（只说了投递方式）

**托管**:
把长任务交给能独立维持它的归属方，让等待脱离当前调用；长任务的机制选择由归属方决定。
_Avoid_: 后台（只说了一种归属）、所有权（同一概念另起一词）

### provider 与模型

**provider 条目**:
models.yml 中 `providers.<provider>` 下的配置条目，只承载连接面：baseUrl、api（协议族）、auth/apiKey/headers、transport、discovery。同一端点上所有模型共用的事实才写在这里。
_Avoid_: provider 配置（与 model 条目统称时混层）、端点配置（发现端点与推理端点是两个端点，单称「端点」分不清指哪个）

**model 条目**:
models.yml 中 `providers.<provider>.models[]`（自定义模型）或 `providers.<provider>.modelOverrides`（只覆盖内建模型的元数据）下的条目，把端点上的一个模型翻译成 omp 本地元数据：id、能力声明、上下文/输出预算、价格、thinking 声明。
_Avoid_: 模型配置（与 config.yml 的 `modelRoles` 撞名——那是角色分配，不定义模型）

**端点方言**:
同一协议族之内端点各自的具体 wire 习惯：thinking 字段形状、effort 字符串、strict 工具字段、stateful responses 之类的怪癖；由 compat 键逐个修正。对照 API family（`api` 字段）：api 决定 wire 的大形状，方言是同族内的小差异。
_Avoid_: API 类型（像在说 `api` 字段的取值）、协议（与协议族混）

**档位（ThinkingLevel）**:
会话侧的思考强度选择：`off|minimal|low|medium|high|xhigh|max|auto|inherit`，经 `--model <provider>/<model>:high`、`/model` 选择器、`modelRoles` 后缀表达；`auto` 由 omp 逐轮按问题的开放程度选档。对照 `thinking.mode` / `efforts`——档位是 OMP 侧的会话选择，mode/efforts 是 models.yml 里模型侧的声明。
_Avoid_: effort（是档位经映射后发往上游的字符串之一）、思考模式（与 `thinking.mode` 撞名）

**证据通道**:
验证一个 provider/model 配置的五条取证途径：`omp models --json`（静态面）、`PI_REQ_DEBUG=1`（wire 请求/响应原文）、回显探针 `echo-endpoint.py`（请求形状 + 工具闭环）、`omp bench --cache`（缓存命中）、session JSONL（usage 语义）。取证的先后是标准验证流程的事，通道本身只按需取用。
_Avoid_: 测试步骤（通道是取证面，步骤才是顺序流程）、验证四问（四问是回答什么，通道是怎么取证）

### 顾问团

**顾问团**:
ask-consultants 插件的机制名与用户面称呼：多个不同模型的顾问对同一问题各自独立出意见，主模型以主位者身份汇总——权衡分歧、裁决路线、给出最终结论，不复述成员意见。
_Avoid_: 面板（同一载体另起一词，且与 UI 面板控件撞义）

**成员**:
顾问团里的一个模型位，来自成员配置或消息里点名的 `^provider/id` 标签。
_Avoid_: 面板成员（面板已废弃）、伪名成员（伪名已废弃）

**代号**:
`^` 模型标签在会话内注册出的 agent 名（m1、m2、…），task 工具按它把派发集合与本次清单一一对号。机制层面是 OMP 的 user-tagged model agents。
_Avoid_: 伪名（「伪」暗示冒用假名，实际是用户点名的正名）

**派发**:
把同一段 brief 一次调用并行发给各成员的动作；成员互不可见、独立出报告，汇总只发生在全部报告返回之后。
_Avoid_: 扇出（同一动作另起一词）
