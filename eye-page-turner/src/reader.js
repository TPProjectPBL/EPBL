/* 阅读主页面（被控页）逻辑：监听检测引擎广播，执行翻页滚动 */
import { createChannel, MSG_TYPE } from './channel.js';

const channel = createChannel();
const linkEl = document.getElementById('r-link');
const modeEl = document.getElementById('r-mode');
const toast = document.getElementById('r-toast');

let toastTimer = null;

function flash(text) {
  toast.textContent = text;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

function setLink(on) {
  linkEl.textContent = on ? '检测引擎已连接' : '等待检测引擎…';
  linkEl.className = 'r-chip' + (on ? ' on' : '');
}

channel.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  switch (msg.type) {
    case MSG_TYPE.PAGE: {
      const delta = msg.action === 'next'
        ? window.innerHeight * 0.9
        : -window.innerHeight * 0.9;
      window.scrollBy({ top: delta, behavior: 'smooth' });
      flash(msg.action === 'next' ? '▼ 下一页' : '▲ 上一页');
      break;
    }
    case MSG_TYPE.MODE:
      modeEl.textContent = '模式：' + (msg.label || msg.mode);
      break;
    case MSG_TYPE.STATUS:
      if (msg.status === 'ready') setLink(true);
      break;
    case MSG_TYPE.PING:
      // 主页面回应在线（引擎侧可据此确认有被控页存在）
      channel.postMessage({ type: MSG_TYPE.PONG });
      break;
  }
};

// 加载完成后探测引擎是否已在线
channel.postMessage({ type: MSG_TYPE.PING });

window.addEventListener('beforeunload', () => channel.close());
