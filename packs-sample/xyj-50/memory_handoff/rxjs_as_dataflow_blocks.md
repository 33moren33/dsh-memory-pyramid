---
name: RxJS 作为 TypeScript 的数据流原子块库
description: 代码数据流可视化的调研结论——现有 DFG 工具在 JS/TS 上全线失效，转而用 RxJS 算子集当固定块表
type: reference
---

## 核心结论

**RxJS（约 93 个固定算子）可以当作 TypeScript 版的 Simulink 原子操作库。** `pipe()` 本身就是数据流图的文本表达形式。

## 三层可视化架构

| 层 | 实现 | 可视化方式 |
| --- | --- | --- |
| 模块间连接 | 模块声明里的 inputs / outputs / bus | 声明式，自动画线 |
| 模块内部（数据变换） | 用 RxJS pipe 重写 | 每个算子 = 一个块，自动可视化 |
| 模块内部（UI 渲染） | render() 保持原样 | 类似 MATLAB Function 块，代码 + AI 辅助 |

## 调研历程（走过的七条弯路，逐条记下以免重跑）

1. 现有工具全部只做调用图 / 依赖图 / 控制流，**没有真正的数据流块图**——这是一片空白地带。
2. **COMEX**（IBM）有真 DFG，但只支持 Java 和 C#。
3. **ATLAS** 有真 DFG，但只支持 C 和 C++。
4. **Joern** 声称支持 JS/TS，实测遇到闭包与高阶函数就**数据流断链**。
5. 「先编译到 C 再分析」走不通：ts2c 只覆盖约 70% 的 ES3；V8 TurboFan 那条路需要运行时且变量名已丢失。
6. 展开模板方案（把 map 展开成 for 循环）：乐观估计 15 个模板，实际需要 50–100 个，且组合爆炸。
7. **关键转折**：TypeScript 的类型系统本身就是端口定义，而且比 C 更丰富，**根本不需要编译到 C**。

## 关键洞察

- **声明式模块能被标准化解析，是因为接口和行为分离**：inputs / outputs 是声明式 JSON，机器直接读得懂。
- **普通 TS 代码难解析，是因为接口和行为混在一起**：必须读懂代码才知道它依赖了什么。
- **RxJS 的 pipe 天然把两者统一**：每行一个算子是行为，算子的类型签名是接口。
- **TS 类型系统强于 C 类型系统**：TS 直接给出每个端口的精确结构（细到字段级），C 还要去翻头文件。

## 参考地址

- RxJS: https://rxjs.dev/api 与 https://rxmarbles.com/
- IBM COMEX（RDA 算法参考）: https://github.com/IBM/tree-sitter-codeviews
- Joern（JS DFG 有缺陷）: https://github.com/joernio/joern
- ATLAS（C/C++ DFG）: https://github.com/jaid-monwar/ATLAS-multi-view-code-representation-tool
- ts2c（TS→C 实验）: https://github.com/andrei-markeev/ts2c
- Glance（Haskell 可视化）: https://github.com/rgleichman/glance

## 待验证

RxJS 的覆盖度：拿一个真实的复杂前端文件，逐条分析其数据逻辑，找出 RxJS 无法覆盖的场景。
