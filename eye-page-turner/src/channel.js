/* 跨标签页通信（阶段 3）
 * 通过 BroadcastChannel 在同源标签页间广播翻页指令。
 * 检测引擎页（index.html）→ 广播指令 → 主页面（reader.html）执行翻页。
 */

export const CHANNEL_NAME = 'eye-page-turner';

export const MSG_TYPE = Object.freeze({
  PAGE: 'page',     // 翻页指令：{ type:'page', action:'next'|'prev' }
  MODE: 'mode',     // 模式通知：{ type:'mode', mode:'gaze'|'gesture', label }
  STATUS: 'status', // 引擎状态：{ type:'status', status:'ready'|'stopped' }
  PING: 'ping',     // 主页面探测引擎是否在线
  PONG: 'pong',     // 引擎响应在线
});

export function createChannel() {
  return new BroadcastChannel(CHANNEL_NAME);
}

/** 发送统一格式消息 */
export function post(channel, type, payload = {}) {
  channel.postMessage({ type, ...payload });
}
