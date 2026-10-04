# AI Agent Instructions

PNDS 仪表工程 Mobile Sensor Meter：手机倾斜 / 运动 / 麦克风电平双端实时读表
（issue xO-xN/PNDS-App#142、#143）。
Node 24 + Express + Socket.IO，纯网络工程（audio none）。

## 规则

- 只用 npm；完成标准：`npm run check` + `npm test` 全绿；新逻辑随改动带测试。
- 传感器数值规则是契约：零是真实读数、null 是缺失，两者绝不合并（页面上 null 显示「不可用」）。
- 新鲜度只来自真实样本时间戳；心跳、状态广播都不算新样本。
- 停止后的迟到事件 / 迟到授权结果不得改写或重启采集（epoch / attempt 守卫）。
- 采集（≤60 Hz）/ 发送（≤30 Hz）两级限频独立；线上只发最新处理值。显示不设第三级限频：monitor 以帧率向最新样本指数平滑（control-rate 思路），页面不显示任何速率计数。
- 已断开设备的卡片保留 10 秒宽限期后从 monitor 名册消失（render.js `DISCONNECTED_HIDE_AFTER_MS`）；服务端 claim 不受影响，重连恢复原设备号。
- 手机端逻辑全部在 public/sensor-logic.js 与 public/mic-logic.js（Node 可 require），测试驱动的是手机运行的同一份代码。
- 麦克风（#143）是独占资源：停止 / 离开页面 / 后台都释放流与 AudioContext；分析图永不连 destination（不回放）；迟到授权只报告事实并立刻释放流。RMS / 峰值量纲为归一化 FS，电平为 dBFS（地板 −90，mic-logic.js `MIC_LEVEL_FLOOR_DB`）——未经校准，绝不称 dB SPL。mic 的 seq 在控制器生命周期内单调递增、从不重置（服务端记录跨暂停存活，重置会被当作重放拒收）。getUserMedia 只在用户手势内请求；非安全上下文（纯 HTTP）下 mediaDevices 不存在，读「不支持」并提示需要 HTTPS。

## 任务追踪

本工程的实现任务暂挂 PNDS App 仓库的 issue（xO-xN/PNDS-App）；独立仓库与
Utilities 发布清单待真机验收后建立。
