---
name: 插件生态调研 + 引导层选型(2026-08-16)
description: 某新兴 agent harness 的前端形态核实、官方 onboarding 座位与 inert 冲突、遮罩库许可证陷阱、生态克隆密度实测
type: reference
---

# 地基事实（已读源码核实）

该 harness 的界面**是真正的浏览器前端**（React + Vite，本地 3080 端口），**不是终端 TUI**。全仓搜 ink / blessed / inquirer / @clack 零命中。结论：半透明遮罩挖洞高亮这类做法**可行**。

**官方已自带首次运行引导设施，不必自己发明**：

- 座位 `settings.onboarding`（`packages/client/ui-settings/src/client/contract/slots.ts:63-73`）：list 型、root 域，shell 按 order 一次挂一步，步骤自己判 readiness（渲染 null 则不挡任何东西），调 `complete()` 交棒。owner props = `stepId` / `complete` / `openSection`（同文件 :128-135）。
- 原语 `OnboardingSurface`（`packages/client/ui-primitives/src/OnboardingSurface.tsx`，仅 34 行，已从包 index 导出）：body portal 遮罩 + 舞台。
- 官方 models 设置包自己就注册了两步（`.../ui-settings-models/src/client/index.ts:125-135`）。

**⚠️ inert 冲突（读源码才看清，光看文档发现不了）**：`OnboardingSurface` 挂载期把 `#root` 设为 `inert`（:24），而 inert 由祖先继承、子孙无法退出。所以**官方原语给的是「全黑 + 只能点引导框里的下一步」，做不出「挖洞让你点真按钮」**。

**解法**：slot 契约原文写明 chrome 归注册方所有、shell 自己不画任何东西（slots.ts:67-71）。因此**注册进 `settings.onboarding` 只拿生命周期调度，画面自己渲染，不碰 inert**，两者不打架。

# 遮罩库选型

**选 driver.js**：MIT / gzip 5.9KB / 零依赖 / 原生 JS，且是唯一**真做交互拦截**的（`overlayClickBehavior` + `disableActiveInteraction` + `allowClose:false`）。多数同类只是视觉压暗，遮罩 `pointer-events:none`，点得穿。

**⛔ AGPL 陷阱**：`intro.js` 与 `shepherd.js` **都是 AGPL-3.0 + 商业双授权**，链进去会传染，自己的插件被迫也 AGPL。react-joyride / @reactour 是 MIT 但绑死 React，Onborda 绑死 Next.js。

自己手写最小版约 80–120 行。SVG mask 挖洞最正统；`box-shadow: 0 0 0 9999px` 写法最短，但阴影不是 DOM，**做不到点击拦截**。坑在 scroll / resize 时重算坐标。

# 生态密度实测（`gh search repos --topic <生态标签>`）

**整个生态不到一周大（仓库 updatedAt 全部集中在四天内），4000+ 仓库，典型淘金潮。星数极度头重脚轻。**

- **桌宠：约 40+ 个克隆。** 头部三家 3840 / 2896 / 177 星，**长尾 30+ 个全在 0–7 星**。
- **通知提醒：约 40+ 个克隆。** 头部 50 / 16 / 15 星，**长尾 30+ 个全在 0–4 星**。且绝大多数是「任务完成 → 系统级 toast」，**不是** in-app 引导型弹窗。
- **in-app 引导 / onboarding 插件：一个都没有。** 六路关键词 + `gh search code "settings.onboarding"` 零命中。叫 tutorial / guide 的全是给开发者看的文档仓。

**可参考的邻居**：一个 428★ 的恶搞项目把界面变成 2005 年门户网站弹窗风格，是唯一高星的页内浮层类，证明页内 overlay 走得通且靠新奇能拿星；一个 116★ 的项目在模型回复里内联渲染交互 UI，是「用对话本身做引导」的现成载体；另有成就徽章 + 解锁 toast 类项目，是最接近游戏化引导的形态。

**方法论沉淀：** 本生态实测给出的答案是，**抄走时间真的就是一天**，40 人三天内各造一只桌宠。护城河不在实现难度，在**抢空类目 + 命名类目**。任何新插件提案，先跑一遍 topic 搜索数一下克隆数量再决定。

# 桌宠形态的独立否决理由（与红海无关）

Clippy 失败的机制：**有脸暗示「我懂你」，却不问就弹、且从不记住偏好**（斯坦福 Nass 的研究记录）。期待被抬高又被辜负，比无脸工具更招恨。开发者群体尤甚，主动弹出解释等于噪音。

要区分：GitHub 章鱼猫 / Docker 鲸鱼 / Rust 螃蟹是**品牌吉祥物**（不说话、不指点）。开发者工具里「会说话的常驻小助手」零成功案例。

技术侧：`live2d-widget` 是 GPL-3.0（传染）且 Cubism Core 闭源、商用有门槛；`pixi-live2d-display` 是 MIT 但已停更四年；`clippy.js` 原仓已死且依赖 jQuery。**要做吉祥物只有纯 SVG/CSS 自绘才无版权负担。** 可借鉴 VPet 的「有状态 + 可彻底关闭」。
