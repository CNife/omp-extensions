---
name: nmem-guide
description: 搜过去知识 / 存新知识 / 查 nmem 命令树时进来。
---

# nmem-guide

nmem 是本地优先、图谱增强的跨工具个人记忆层：存蒸馏后的 durable 知识，不存会话原文。

## 分工

- 本机历史、某次修复、某段对话 → 先 `obelisk`（本地事实层，只读）。
- 跨机器经验、已蒸馏的决策 / 偏好 / 流程，或 obelisk 关键词检索没命中的模糊语义回忆 → nmem memory。
- 会话原文由本插件自动同步为 thread：确需对话结构时才 `t search` / `t show`，不手动存。

## 搜索

默认不加 `--json`：输出每条一行（完整 ID、title、score、type、importance）。先看表挑 ID，再按需读全文。

```bash
nmem m search "3-7 词语义查询"              # 默认 10 条
nmem m search "auth 架构 决策" --mode deep  # 结果弱或偏概念时
nmem m show <id>                            # 读全文
nmem t search "query" -n 5                  # 确需会话结构时
nmem t show <thread_id> -n 8 --offset 0 --content-limit 1200
```

- 分数 0.6-1.0 直接匹配，0.3-0.6 相关，低于 0.3 跳过。
- 如果当前讨论值得沉淀，顺手蒸馏一条。
- 读命令默认不加 `--json`；只有要把整段正文交给脚本消费时才加 `--json -n 5`：用 `-n` 限流，不要 `| head` 截断 JSON。写命令（`m add` / `m update`）固定加 `--json`，返回 `success` / `id` / `updated_fields`。

## 保存

产出 durable 的事实、偏好、决策、计划、流程、教训、事件时主动存，不等被问。跳过：常规修复、很快就会变的进行中工作、文档能答的 Q&A、通用常识。质量优先：一个会话 1-3 条，原子、可操作，标题自带信息。

```bash
# 1. 查重
nmem m search "related query"

# 2. 新建：正文走 --stdin，反引号、$、换行都按字面进库
nmem --json m add --stdin -t "Title" --unit-type decision -i 0.9 -l <label> <<'EOF'
content
EOF

# 3. 命中相近记忆、只是细化 → 改写它，别另起一条（一条强 memory 胜过三条弱的）
nmem --json m update <id> -c 'updated content'
```

- `--unit-type`：`fact` / `preference` / `decision` / `plan` / `procedure` / `learning` / `context` / `event`。
- `-i` importance：0.8-1.0 架构决策 / 生产事故 / 核心偏好；0.5-0.7 调试见解 / 工作流 / 项目约定；0.3-0.4 小技巧 / 一次性观察。
- `-l <label>` 可重复，用于归类；`m update` 也能传，且整体替换标签。
- `m update` 是全量替换且没有 `--stdin`：先 `nmem m show <id>` 读原文，再整段覆盖 `-c`，可同传 `-t` / `-i` / `--unit-type`。新正文跨行或含单引号时，先包成变量（`body=$(cat <<'EOF'` … `EOF` 后换行 `)`），再 `-c "$body"`。

## 其他

- 查 nmem 还能干什么：`nmem --help` 看组，`nmem <group> --help` 看子命令与 flag。
- `nmem context` / `nmem wm read` 是 opt-in 的启动上下文，OMP 不自动注入，要用时自己取。
- 出问题先 `nmem status`；连不上再看 `nmem doctor`。
