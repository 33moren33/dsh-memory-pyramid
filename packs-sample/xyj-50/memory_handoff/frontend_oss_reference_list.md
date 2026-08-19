---
name: 前端 / 可视化 / 语音 开源参考项目清单
description: 做 agent 可视化界面时按模块整理的开源参考项目，含仓库地址与各自可借鉴的点
type: reference
---

按模块分类，每条都写明「拿它来看什么」，避免日后重新检索。

## 游戏 / 渲染架构（已下载精读过）

| 项目 | 可借鉴的点 |
| --- | --- |
| Kaetram（2D MMORPG） | 2D 游戏架构、摄像机、瓦片系统、实体管理 |
| SkyOffice | Phaser 与 React 的集成方式、实时状态同步 |
| Pretext | Canvas 文字测量与布局，中文和代码混排 |
| MiroFish | 多 agent 行为模拟逻辑 |

## 前端框架 / agent 驱动 UI

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| CopilotKit (AG-UI) | github.com/CopilotKit/CopilotKit | AG-UI 协议实现，agent 控制前端 |
| CopilotKit Generative UI | github.com/CopilotKit/generative-ui | AG-UI + A2UI 示例 |
| Google A2UI | github.com/google/A2UI | 官方 A2UI 协议与渲染器 |
| @xpert-ai/a2ui-react | npm 包 | A2UI 的 React 渲染器（shadcn / Tailwind） |
| React Joyride | github.com/gilbarbara/react-joyride | 可编程的产品引导与高亮 |

## 对话记录解析 / 监控面板

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| claude-code-viewer | github.com/d-kimuson/claude-code-viewer | JSONL 解析、diff 查看器、SSE 实时同步、多语言 |
| claude-run | github.com/kamranahmedse/claude-run | 对话美化 UI、session 列表 |
| pixel-agents-standalone | github.com/rolandal/pixel-agents-standalone | 独立 Web 版像素 agent sprite 系统 |
| claw-empire | github.com/GreenSheep01201/claw-empire | 多 provider 办公室、sprite、任务看板 |

## 数据可视化

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| bloomberg-terminal | github.com/feremabraz/bloomberg-terminal | Bloomberg 风格深色面板布局 |
| LLMTracker | github.com/habeebmoosa/LLMTracker | Token 用量 Recharts 图表 |
| Langfuse | github.com/langfuse/langfuse | LLM 观测平台的整体形态 |

## 语音控制

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| Picovoice Rhino | github.com/Picovoice/rhino | 语音转意图，自定义唤醒词 |
| Vosk | github.com/alphacep/vosk-api | 50MB 的离线中文 STT |
| VoiceStreamAI | github.com/alesaccoia/VoiceStreamAI | Whisper + WebSocket 实时流 |
| whisper_streaming_web | github.com/ScienceIO/whisper_streaming_web | FastAPI + WebSocket + Whisper |

## PixiJS 生态

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| @pixi/react | github.com/pixijs/pixi-react | PixiJS 的 React 声明式绑定（官方） |
| pixi-viewport | github.com/pixijs-userland/pixi-viewport | 2D 摄像机：拖拽 / 缩放 / 跟随 / 惯性 |
| pixi-graph | github.com/zakjan/pixi-graph | PixiJS 力导向图 |
| pixi-network-visualization | github.com/RaleighHan/pixi-network-visualization | 大规模网络图（15k 节点 WebGL） |
| ngraph.pixi | github.com/anvaka/ngraph.pixi | 2D 图渲染引擎 |
| pixijs-ts-vite-template | github.com/turbokirichenko/pixijs-typescript-vite-template | PixiJS + TS + Vite 脚手架 |
| PixiJS Open Games | github.com/pixijs/open-games | 项目脚手架、动画、资产加载 |
| Systemize | github.com/Vynlar/Systemize | PixiJS ECS 游戏引擎 |
| heatcanvas | github.com/sunng87/heatcanvas | Canvas 热力图（叠加层用） |

## 像素 / 复古 UI 组件

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| RetroUI | github.com/Dksie09/RetroUI | 像素风 React 组件库 |
| Pixelact UI | github.com/pixelact-ui/pixelact-ui | 基于 shadcn 的像素风组件 |
| nes-ui-react | kyr0.github.io/nes-ui-react | NES 风格 React UI |
| snes.css | github.com/devMiguelCarrero/snes.css | 16bit 复古 CSS 框架 |

## 模拟经营 / 任务调度

| 项目 | 地址 | 可借鉴的点 |
| --- | --- | --- |
| shapez.io | github.com/tobspr-games/shapez.io | 工厂游戏架构（仅架构参考，不直接使用） |
| Project Porcupine | github.com/TeamPorcupine/ProjectPorcupine | 《缺氧》风格架构（C# / Unity） |
| libcolony | github.com/mafik/libcolony | 殖民地任务调度算法（有 JS bindings） |
| Tile Fighter | github.com/Laastine/tile-fighter | PixiJS 瓦片 + 角色移动 |
