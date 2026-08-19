---
name: 主流 CLI agent 内置能力盘点(2026-07-06)
description: Claude Code 2.1.104+ 与 Codex CLI 0.142 的内置功能对照——自建 agent 基建前先看哪些已被官方覆盖
type: reference
---

2026-07-06 双路调研，用于回答「自己造还是骑官方」这个反复出现的问题。

# 两家都还空着的位置

- **队列驱动的哑派发器**：两家的 automations / Routines 都是「固定 prompt 定时跑」，不是「从队列里取一张卡再执行」。
- **由 verify 命令裁决任务是否算完成的门禁闭环**。
- **产物级的意见反馈通道**（针对某个具体产出提异议，而非针对会话）。
- **审讯式回溯**：回到当时的上下文里再问它一遍。

# 官方已覆盖，值得直接骑上去的

- **任务台账存储层**：Claude Code 的跨会话 Tasks 已持久化（`~/.claude/tasks/`），带文件锁认领与多实例同步。缺 verify 与 tags 字段，但底座可用。
- **记忆自整理**：Claude Code 的 Auto Memory + Auto Dream（24 小时 + 5 段对话触发自动整理）；Codex 的 Memories（会话结束后后台抽取经验，再做 consolidation）。两家都是两段式，自建的话只需补「结构化 delta + 人工审 diff」。
- **生命周期钩子**：两家 hooks 齐全，没有理由自己造。
- **门禁理念**：Claude Code 的 `/goal` + Outcomes 独立 Grader（付费托管），以及 `TaskCompleted` hook 用 exit code 2 拦截「完成」声明。

# 计费

`-p` / SDK 脱离订阅池的计划（原定 6 月至 15 日）确认暂停，仍走订阅。Codex 的 automations 共享订阅额度。Claude Code 的 Routines 是云托管，计费方式待查。

# 坑

- Claude Code resume 之后 `parentUuid` 冲突（issue #36583），任何依赖对话树完整性的回溯功能都会被它威胁。
- 「fork 到任意一条消息」仍是未实现的 feature request。
- 本轮调研中 Claude Code 侧部分信息来自第三方站点（claudearchitect / claudefa.st），**动工前必须回官方 changelog 复核版本号**。

**结论的时效性警告**：官方功能在一个月内快速逼近了上面「空着的位置」。任何基于本卡的「造还是买」判断，超过一个月就应重新核对。
