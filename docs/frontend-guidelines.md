# 前端开发规范（交互与骨架）

本文档定义 `apps/web-ui` 的交互、骨架和刷新行为约束，用于避免回归（闪烁、抖动、位移、NaN 文案等）。

## 1. 核心原则

### 1.1 同构骨架（Structural Skeleton）

- `loading` 与 `loaded` 必须共享同一套 DOM 结构与网格轨道。
- 禁止在常见组件中使用“整棵树替换式骨架”（`if (loading) return completely different tree`）。
- 骨架只替换内容层（文字、条形、占位块），不替换容器层（grid/flex/行列数量）。

### 1.2 刷新不回退骨架（SWR 视觉策略）

- 已有历史数据时刷新，默认保留旧数据展示，不回退 skeleton。
- skeleton 仅用于首屏无数据阶段。

### 1.3 交互稳定优先

- hover/selected 不得互相抢焦点。
- 小尺寸图表交互必须经过边界命中稳定性验证。

## 2. 统计页约束

## 2.1 本周节奏（Weekly Rhythm）

- 双色条为“重叠圆角矩形”模式：
  - 应用（蓝）在下层；
  - 活跃（绿）在上层；
  - 渲染关系必须满足 `应用 >= 活跃`。
- 禁止出现 `undefined`/`NaN` 的 weekday 或数值文案。
- 右侧轴列宽固定（非 auto），避免加载前后宽度挤压。
- 周汇总文案容器（`strong/small`）需固定行高，避免刷新时上下跳。

## 2.2 使用热度（日历）

- 日历单元格必须具备 hover 反馈（边框/阴影/轻微抬升），但不能破坏选中态与今日态。
- 加载态与完成态保持同构，禁止因 legend/header/summary 文本高度差导致位移。

## 2.3 应用分布 / 域名分布（主 Donut）

- 圆环与中心文字必须使用同一坐标系居中。
- 中心文案层使用固定 overlay 容器，不能依赖图表引擎内部文本布局来做视觉对齐。
- 图表容器内边距必须在父层统一处理，避免“图居中、字不居中”。

## 2.4 状态分布（Compact Donut）

- 与主 donut 保持一致交互模式（hover 放大、阴影、颜色策略）。
- 选中态与 hover 态需隔离，避免高亮抖动与 tooltip 来回切换。

## 3. 刷新与数据健壮性

## 3.1 日期与派生数据

- 任何依赖日期的派生计算（如 week bars）必须先校验日期格式。
- 日期无效时返回安全空值，不得渲染异常文本。

## 3.2 首屏与刷新

- 首屏：无数据可显示同构骨架。
- 刷新：有旧数据时继续显示旧数据，仅做局部更新标识（如 refresh badge）。

## 3.3 路由、日期与轮询

- 日期必须写入 Hash 查询参数（`#/timeline?date=YYYY-MM-DD`）；浏览器前进/后退时 URL 是日期状态源。
- 今天的时间线和汇总每 10 秒刷新，历史日期不轮询；设置页监视器每 5 秒刷新。
- React Query 默认在页面不可见时暂停 interval，不要开启后台轮询。
- 午夜 rollover 必须更新今天的 query key；若用户仍停留在旧“今天”，自动切换到新日期。

## 3.4 图表主题与加载边界

- ECharts 只能从 `components/echarts-runtime.ts` 注册和导入，统计页以外不得加载 ECharts chunk。
- 图表 option 使用显式 `resolvedTheme` 和纯色 token，不在 chart model 或 `useMemo` 内读取 DOM 计算样式。
- 主题变化必须进入 option 的 memo 依赖，切换后立即更新 tooltip、坐标轴和网格颜色。

## 3.5 时间线性能

- 搜索输入使用 `useDeferredValue`，每条 segment 的搜索文本预计算，避免每次按键重复归一化。
- 应用/域名区间关联使用时间排序 interval sweep，不得恢复为 `O(F×B)` 双重全表扫描。
- 大于 200 条的事件列表使用虚拟窗口；普通长列表使用 `content-visibility:auto`。

## 3.6 无障碍与响应式

- 页面只允许一个 `h1`，区块标题从 `h2` 开始，禁止跳级。
- ECharts 提供文本摘要或视觉隐藏数据表；时间线条必须可聚焦并说明名称、时间和时长。
- 时间窗口控制柄使用 `role="slider"`、`aria-value*` 和键盘增减。
- 尊重 `prefers-reduced-motion`；小屏导航改为紧凑横向布局，交互目标最小 44px。

## 4. Skeleton 实施清单

每次新增/重构卡片时，至少验证以下项：

- [ ] loading/loaded 的容器层级完全一致。
- [ ] 行列数一致（grid columns、row wrapper 数一致）。
- [ ] 文本容器固定高度（如 `strong/small`、轴标签、摘要行）。
- [ ] 关键轨道固定尺寸（如轴列宽、图表主区高度）。
- [ ] 刷新时已有数据不回退 skeleton。
- [ ] 无 `undefined`/`NaN` 可见文案。

## 5. 验收标准

- 人眼验收：切换 `loading -> loaded`，卡片外框与主区不应出现明显位移。
- 交互验收：hover 与 selected 连续稳定，无闪烁、抢焦点。
- 工程验收：`npm run build` 与 `npm run lint` 必须通过。

## 6. 变更建议流程

1. 先改结构（同构）再改样式（细节）。
2. 先保证稳定，再微调动画/阴影强度。
3. 每次改动后执行 build + lint + 手工刷新场景回归。
