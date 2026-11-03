/* =====================================================================
   控制后端 WebSocket 客户端

   - 连接 /ws?token=...
   - 发送 cursor（归一化 0–1）、gesture（name + state）、dwell
   - 断线自动重连
   ===================================================================== */

export function createBackend(url, token) {
  let ws = null;
  let cursor = { x: 0.5, y: 0.5 };
  let retryTimer = null;
  const listeners = [];

  function notify(msg) {
    listeners.forEach((fn) => { try { fn(msg); } catch (e) {} });
  }

  function connect() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    try {
      ws = new WebSocket(url + "?token=" + encodeURIComponent(token));
    } catch (e) {
      scheduleRetry();
      return;
    }
    ws.onopen = () => notify({ type: "state", connected: true });
    ws.onclose = () => { notify({ type: "state", connected: false }); scheduleRetry(); };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let msg = e.data;
      try { msg = JSON.parse(msg); } catch (_) { /* 非 JSON 原样传 */ }
      notify(msg);
    };
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(connect, 1500);
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }
    return false;
  }

  return {
    connect,
    sendCursor(x, y) {
      cursor = { x, y };
      send({ type: "cursor", x, y });
    },
    sendGesture(name, state) {
      send({ type: "gesture", name, state });
    },
    sendDwell(x, y) {
      send({ type: "dwell", x, y });
    },
    onMessage(fn) { listeners.push(fn); },
    get connected() { return !!(ws && ws.readyState === 1); },
    get cursor() { return cursor; },
  };
}
