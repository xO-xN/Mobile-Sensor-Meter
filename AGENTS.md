# AI Agent Instructions

PNDS 诊断工程：手机倾斜 / 运动双端实时诊断（issue xO-xN/PNDS-App#142）。
Node 24 + Express + Socket.IO，纯网络工程（audio none）。

## 规则

- 只用 npm；完成标准：`npm run check` + `npm test` 全绿；新逻辑随改动带测试。
- 传感器数值规则是契约：零是真实读数、null 是缺失，两者绝不合并（页面上 null 显示「不可用」）。
- 新鲜度只来自真实样本时间戳；心跳、状态广播都不算新样本。
- 停止后的迟到事件 / 迟到授权结果不得改写或重启采集（epoch / attempt 守卫）。
- 采集（≤60 Hz）/ 发送（≤30 Hz）两级限频独立；线上只发最新处理值。显示不设第三级限频：monitor 以帧率向最新样本指数平滑（control-rate 思路），页面不显示任何速率计数。
- 已断开设备的卡片保留 10 秒宽限期后从 monitor 名册消失（render.js `DISCONNECTED_HIDE_AFTER_MS`）；服务端 claim 不受影响，重连恢复原设备号。
- 手机端逻辑全部在 public/sensor-logic.js（Node 可 require），测试驱动的是手机运行的同一份代码。

## 任务追踪

本工程的实现任务暂挂 PNDS App 仓库的 issue（xO-xN/PNDS-App）；独立仓库与
Utilities 发布清单待真机验收后建立。
