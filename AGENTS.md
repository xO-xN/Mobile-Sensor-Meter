# AI Agent Instructions

PNDS 诊断工程：手机倾斜 / 运动双端实时诊断（issue xO-xN/PNDS-App#142）。
Node 24 + Express + Socket.IO，纯网络工程（audio none）。

## 规则

- 只用 npm；完成标准：`npm run check` + `npm test` 全绿；新逻辑随改动带测试。
- 传感器数值规则是契约：零是真实读数、null 是缺失，两者绝不合并（页面上 null 显示「不可用」）。
- 新鲜度只来自真实样本时间戳；心跳、状态广播都不算新样本。
- 停止后的迟到事件 / 迟到授权结果不得改写或重启采集（epoch / attempt 守卫）。
- 采集 / 显示 / 发送三级限频独立；线上只发最新处理值。
- 手机端逻辑全部在 public/sensor-logic.js（Node 可 require），测试驱动的是手机运行的同一份代码。

## 任务追踪

本工程的实现任务暂挂 PNDS App 仓库的 issue（xO-xN/PNDS-App）；独立仓库与
Utilities 发布清单待真机验收后建立。
