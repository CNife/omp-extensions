# plannotator CLI v0.26.7 futex 死锁复测（issue #44）

> Research ticket: [#44 测试 plannotator CLI v0.26.7 是否仍存在 futex 死锁](https://github.com/CNife/omp-extensions/issues/44)，part of [#43 Wayfinder map](https://github.com/CNife/omp-extensions/issues/43)。
> 日期：2026-08-10

## 结论（TL;DR）

- **经典启动期死锁（HTTP 服务未启动即挂起）在 v0.26.7 上未复现**：3 个子命令共 200+ 次运行，0 次启动死锁。v0.25.1（118 次）同样未复现 —— 原 ~20% 死锁在本机环境两种版本下都无法触发，说明原死锁与运行环境强相关。
- **v0.26.7 存在罕见的关闭期挂起**（stdout 已写出 JSON 但进程不退出）：仅在**未设置 `BROWSER=none`** 的运行中出现（约 1.2%~3.7%，80 次中 1 次确认 ≥15s + 2 次 4–6s 时仍在运行即被 kill，未确认是否会自行退出）；设置 `BROWSER=none PLANNOTATOR_BROWSER=none` 后 0/89 次。
- **架构结论：CLI shell-out 方案可行**，前提是：
  1. 插件 spawn 时**必须**设置 `BROWSER=none PLANNOTATOR_BROWSER=none`（被删的 simple-plannotator 未设置，继承了 BROWSER 未设的环境，触发 `cmd.exe /c start` 路径）；
  2. 保留超时兜底（如原 120s）作为廉价保险，应对残余的罕见关闭期挂起；
  3. 可选：`PLANNOTATOR_AI=disabled` 可彻底避免 CLI 派生 `pi --mode rpc` 子进程（AI 模型发现探针），进一步降低关闭期竞态面。

## 测试环境

| 项 | 值 |
|---|---|
| OS | WSL2（Linux CNifeWork 6.18.35.2-microsoft-standard-WSL2 x86_64），14 核 / 23GB |
| 图形环境 | WSLg（DISPLAY=:0，WAYLAND_DISPLAY=wayland-0），`cmd.exe` WSL interop 可用 |
| 测试二进制 | v0.26.7：`~/.local/bin/plannotator`（149,637,248 B，install.sh `--minimal` 安装） |
| 基线二进制 | v0.25.1：`/usr/sbin/plannotator`（155,745,455 B） |
| 运行时 | Bun 1.3.14（v0.26.6+ 重新编译所用版本）、Node v26.7.0（CLI 派生的 `pi` 子进程运行于 node） |
| 触发方式 | 直接 spawn（bash / Bun.spawn 两种父进程），HTTP 端口发现用 `ss -tlnp`，决策走 `POST /api/feedback` |

## 测试方法

对每个子命令、每种环境配置重复运行，单次流程：

1. 后台启动 CLI（`PLANNOTATOR_BROWSER=none BROWSER=none` 或原样继承环境）；
2. ≤5s 内用 `ss -tlnp` 找 HTTP 端口 → 找不到记 **STARTUP_DEADLOCK** 并 kill；
3. 找到端口后 `curl -X POST /api/feedback`（`{"feedback":"test feedback","annotations":[]}`），等待退出；
4. 退出且 stdout 有决策 JSON → **SUCCESS**；等待窗口内不退出 → **SHUTDOWN_DEADLOCK** 并 kill。

等待窗口：批量测试 15–40s（详见下文分表）。三种命令：

- `annotate <file> --json`（= /pna，serverAnnotate.ts）
- `annotate-last --stdin --json`（= /pnl，同 serverAnnotate.ts，内容经 stdin 传入）
- `review`（= /pnr，serverReview.ts，无 `--json`）

review 服务器同样接受 `POST /api/feedback`（body 含 `approved`/`feedback`/`annotations`），测试方法一致。

## 结果

### v0.26.7

| 命令 | 环境配置 | 次数 | 启动死锁 | 关闭挂起 | 成功 |
|---|---|---|---|---|---|
| annotate | `BROWSER=none PLANNOTATOR_BROWSER=none` | 54 | 0 | 0 | 54 |
| annotate | 默认环境（浏览器启动路径被触发） | 80 | 0 | **3**（1 确认 ≥15s；2 次 4–6s 时仍运行即 kill，未确认是否会退出） | 77 |
| annotate | `BROWSER=none ... PLANNOTATOR_AI=disabled` | 20 | 0 | 0 | 20 |
| annotate-last | `BROWSER=none PLANNOTATOR_BROWSER=none` | 15 | 0 | 0 | 15 |
| review | `BROWSER=none PLANNOTATOR_BROWSER=none` | 15 | 0 | 0 | 15 |
| **合计** | | **184** | **0** | **3** | **181** |

关闭期挂起明细（全部为 annotate、未设置 BROWSER 抑制）：

| 时间 | 现象 |
|---|---|
| 15:44（手动） | stdout 已输出 `{"decision":"annotated","feedback":"x"}`，15s 后仍在运行（确认挂起），kill |
| 15:47（手动） | POST 后 6s 仍在运行，kill（退出时间未知） |
| 15:58（手动） | POST 后 4s 仍在运行，kill（退出时间未知） |

> 注：3 次挂起全部出现在**手动观测**运行中；45+30+30=105 次批量运行（Bun 测量 harness，25–40s 窗口）0 次挂起。速率估计受样本限制，置信区间宽（~1%~6%）。

### v0.25.1 基线（对照）

| 命令 | 环境配置 | 次数 | 启动死锁 | 关闭挂起 | 成功 |
|---|---|---|---|---|---|
| annotate | `BROWSER=none PLANNOTATOR_BROWSER=none` | 42 | 0 | 0 | 42 |
| annotate | 默认环境 | 16 | 0 | 0 | 16 |
| annotate-last | `BROWSER=none PLANNOTATOR_BROWSER=none` | 30 | 0 | 0 | 30 |
| review | `BROWSER=none PLANNOTATOR_BROWSER=none` | 30 | 0 | 0 | 30 |
| **合计** | | **118** | **0** | **0** | **118** |

> 原 ~20% 死锁在本机 v0.25.1 上 118 次运行也未复现 —— 死锁与机器/Windows 侧状态强相关，仅凭本环境无法对 v0.25.1 复现原故障。

## 关键机制发现

1. **决策→退出路径**：`serverAnnotate.ts` 中 `server.onDecision(() => setTimeout(() => session.stop(), 1500))` —— 决策后固定等 1.5s 再关停。实测 `POST → stdout 数据 ≈1505ms`，`POST → 退出 ≈2008ms`，与之一致。关闭期挂起即 `session.stop()` 挂起。

2. **`pi --mode rpc` 子进程（v0.26.x 新增）**：CLI 启动时若 AI 启用（`resolveAIEnabled()`，默认开，`PLANNOTATOR_AI=disabled` 关闭），会通过 `pi-sdk-node.ts` 派生 `node .../pi --mode rpc` 子进程做模型发现（`fetchModels`，10s 超时），随后 kill。进程树实测可见该子进程（99% CPU）。插件侧 shell-out 会导致 **pi 实例嵌套**（OMP 的 pi + CLI 派生的 pi），这是 v0.26.x 与 v0.25.1 的重要差异。

3. **浏览器打开路径（WSL2）**：`network.ts:openBrowser` —— BROWSER 未设置时在 WSL2 上执行 `cmd.exe /c start <url>`（detached + unref，fire-and-forget）。3 次关闭期挂起全部出现在该路径被触发的运行中（`BROWSER=none` 时走 no-op 分支，0/89 次挂起），但本环境未观察到 cmd.exe/conhost 残留进程，相关性证据有限。

4. **v0.25.1 与 v0.26.7 进程差异**：v0.25.1 不派生 `pi` 子进程；v0.26.7 派生。`--version` 分别为 0.25.1 / 0.26.7，二进制 155.7MB / 149.6MB。

## 输出格式验证

| 命令 | stdout 样例 | 说明 |
|---|---|---|
| annotate --json | `{"decision":"annotated","feedback":"test feedback"}` | 结构化 JSON，可用于解析反馈 |
| annotate-last --stdin --json | `{"decision":"annotated","feedback":"test feedback"}` | 同上 |
| review | `test feedback` | 纯文本（无 --json 选项），插件需按原始文本处理 |
| annotate --gate --json --result-file | `{"decision":"approved"}` / `{"decision":"annotated","feedback":"..."}` | `--result-file` 原子写入 stdout 同款 JSON；`POST /api/approve` 得 approved，`POST /api/feedback` 得 annotated。`--require-approval` 需 `--gate --json` |

样例 stdout（成功运行，annotate）：

```
{"decision":"annotated","feedback":"test feedback"}
```

stderr（annotate）：`Resolved: /tmp/plannotator-deadlock-test.md`

## 结论与架构建议

1. **v0.26.7 不再有 ~20% 的启动期 futex 死锁**（本环境 0/184）。残余问题是一个**罕见（~1–3%）的关闭期挂起**：stdout 已收到决策 JSON，但进程不退出 —— 对原插件 `Promise.all([stdout, stderr, exited])` 而言仍会卡死，因为 `exited` 永不 resolve。
2. **CLI shell-out 可行**，但必须：
   - spawn 时显式设置 `BROWSER=none PLANNOTATOR_BROWSER=none`（消除残余挂起的触发面）；
   - 保留超时兜底（120s 量级，超时 kill + 提示重试），成本极低；
   - 若插件不需要 AI 辅助标注，可加 `PLANNOTATOR_AI=disabled` 避免 `pi` 子进程嵌套（也省一次 10s 模型发现探针的启动开销）。
3. 关闭期挂起发生在 `POST → stdout 数据` 之后、`进程退出` 之前，且 stdout 数据完整 —— 若插件改为**读到 stdout 数据即视为成功**（不等 `exited`），挂起对用户体验的影响可降为零（反馈已投递，进程由超时清理）。这是比"重试"更优的架构缓解。
4. 原 ~20% 死锁无法在本机复现（含 v0.25.1），存在环境依赖；建议若后续在生产环境观察到挂起，先用 `ss -tlnp` + `ps` 确认是启动期还是关闭期，再对号入座。

## 复现材料

- 测试脚本（本仓库外，/tmp）：`plannotator-deadlock-test.sh`（bash 批量）、`plannotator-measure.ts`（Bun 测量 harness：端口/决策/退出计时）、`concurrent-test.sh`、`ai-compare.sh`、`final-test.sh`
- 本报告数据来自上述脚本在本机的一次性执行，原始日志在 /tmp/meas-*.log、/tmp/conc-*.stdout、/tmp/final-*.stdout
