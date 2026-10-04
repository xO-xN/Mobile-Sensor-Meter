# AI Agent Instructions

PNDS 仪表工程 Mobile Sensor Meter：手机倾斜 / 运动 / 麦克风电平 / 手部姿态双端实时读表
（issue xO-xN/PNDS-App#142、#143、#144）。
Node 24 + Express + Socket.IO，纯网络工程（audio none）。

## 规则

- 只用 npm；完成标准：`npm run check` + `npm test` 全绿；新逻辑随改动带测试。
- 传感器数值规则是契约：零是真实读数、null 是缺失，两者绝不合并（页面上 null 显示「不可用」）。「未检测到手」（hands 0 + 空 keypoints）同属真实结果，不是错误。
- 新鲜度只来自真实样本时间戳；心跳、状态广播都不算新样本。
- 停止后的迟到事件 / 迟到授权结果 / 迟到模型结果不得改写或重启采集（epoch / attempt 守卫）；迟到的摄像头授权与模型就绪要立刻释放其携带的资源。
- 采集（≤60 Hz）/ 发送（≤30 Hz）两级限频独立；线上只发最新处理值。显示不设第三级限频：monitor 以帧率向最新样本指数平滑（control-rate 思路）。速率计数唯一例外：handpose 的推理耗时与更新率是 #144 要求的诊断量——更新率只统计真实推理完成（2 s 滚动窗口），心跳与 tick 不算。
- 已断开设备的卡片保留 10 秒宽限期后从 monitor 名册消失（render.js `DISCONNECTED_HIDE_AFTER_MS`）；服务端 claim 不受影响，重连恢复原设备号。
- 手机端逻辑全部在 public/sensor-logic.js、public/mic-logic.js 与 public/handpose-logic.js（Node 可 require），测试驱动的是手机运行的同一份代码。
- 麦克风（#143）是独占资源：停止 / 离开页面 / 后台都释放流与 AudioContext；分析图永不连 destination（不回放）；迟到授权只报告事实并立刻释放流。RMS / 峰值量纲为归一化 FS，电平为 dBFS（地板 −90，mic-logic.js `MIC_LEVEL_FLOOR_DB`）——未经校准，绝不称 dB SPL。mic 的 seq 在控制器生命周期内单调递增、从不重置（服务端记录跨暂停存活，重置会被当作重放拒收）。getUserMedia 只在用户手势内请求；非安全上下文（纯 HTTP）下 mediaDevices 不存在，读「不支持」并提示需要 HTTPS。
- 手部姿态（#144）：ml5.js 1.4.0（tfjs/WebGL runtime）+ lite 掌部检测与关键点模型，全部由本站 origin 提供——`public/vendor/` 已提交并固定（`npm run fetch:handpose` 校验 sha256；`GET /handpose/assets.json` 报告清单与缺失）。运行时零 CDN 请求；ml5 只在用户启用手部卡后才懒加载。摄像头与模型是独立阶段、独立失败态（预览活着 ≠ 模型就绪 ≠ 推理完成）。摄像头在停止 / 离开页面 / 后台释放，模型在后台保留（是内存不是设备）、停止才 dispose（ml5 未暴露 dispose，经 `instance.model.dispose()`）。关键点上线前归一化：模型输出像素坐标，除以视频宽高得 [0,1]（原点左上、未镜像——预览的镜像只是 CSS）；线上只传最新结果（推理节奏 ≤10 Hz）+ 推理耗时 + 更新率，绝不传视频。seq 单调不重置（同 mic）。monitor 的关键点详情在 `<details>` 内按 seq 刷新——帧循环绝不重建该元素。

## 任务追踪

本工程的实现任务暂挂 PNDS App 仓库的 issue（xO-xN/PNDS-App）；独立仓库与
Utilities 发布清单待真机验收后建立。
