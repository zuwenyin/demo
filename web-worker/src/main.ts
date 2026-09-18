/**
 * 主线程：只负责 UI 渲染 + 与 worker 收发消息，不做任何网络请求。
 */
import type { PollConfig, WorkerInMessage, WorkerOutMessage } from './types.js';

function pick<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`找不到元素：${selector}`);
  return el;
}

const els = {
  url: pick<HTMLInputElement>('#url'),
  interval: pick<HTMLInputElement>('#interval'),
  timeout: pick<HTMLInputElement>('#timeout'),
  maxAttempts: pick<HTMLInputElement>('#maxAttempts'),
  start: pick<HTMLButtonElement>('#start'),
  stop: pick<HTMLButtonElement>('#stop'),
  reset: pick<HTMLButtonElement>('#reset'),
  clear: pick<HTMLButtonElement>('#clear'),
  state: pick<HTMLSpanElement>('#state'),
  attempts: pick<HTMLSpanElement>('#attempts'),
  progress: pick<HTMLProgressElement>('#progress'),
  progressText: pick<HTMLSpanElement>('#progress-text'),
  log: pick<HTMLUListElement>('#log'),
};

/** 创建 worker：用 import.meta.url 解析路径，保证不管页面挂在哪个路由下都能找到 worker.js */
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

const MAX_LOG_ITEMS = 200;

function now(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function appendLog(level: 'info' | 'ok' | 'warn' | 'error', text: string): void {
  const li = document.createElement('li');
  li.className = `item item--${level}`;

  const time = document.createElement('span');
  time.className = 'item__time';
  time.textContent = now();

  const body = document.createElement('span');
  body.className = 'item__body';
  body.textContent = text;

  li.append(time, body);
  els.log.prepend(li);

  while (els.log.childElementCount > MAX_LOG_ITEMS) {
    els.log.lastElementChild?.remove();
  }
}

function readConfig(): PollConfig {
  const url = els.url.value.trim() || '/api/task/status';
  return {
    url,
    interval: Math.max(100, Number(els.interval.value) || 1500),
    timeout: Math.max(100, Number(els.timeout.value) || 5000),
    maxAttempts: Math.max(1, Number(els.maxAttempts.value) || 20),
    backoffFactor: 1.6,
  };
}

function send(message: WorkerInMessage): void {
  worker.postMessage(message);
}

function setPollingState(polling: boolean, config?: PollConfig): void {
  els.state.textContent = polling ? '轮询中' : '空闲';
  els.state.dataset.polling = String(polling);
  els.start.disabled = polling;
  els.stop.disabled = !polling;

  if (config) {
    els.url.value = config.url;
    els.interval.value = String(config.interval);
    els.timeout.value = String(config.timeout);
    els.maxAttempts.value = String(config.maxAttempts);
  }
}

function renderProgress(progress: number): void {
  els.progress.value = progress;
  els.progressText.textContent = `${progress}%`;
}

function describe(data: { taskId: string; progress: number; status: string; message?: string }): string {
  const extra = data.message ? ` · ${data.message}` : '';
  return `[${data.taskId}] ${data.status} ${data.progress}%${extra}`;
}

// ---------- 接收 worker 消息 ----------
worker.onmessage = (event: MessageEvent<WorkerOutMessage>): void => {
  const message = event.data;

  switch (message.type) {
    case 'result':
      els.attempts.textContent = String(message.attempt);
      renderProgress(message.data.progress);
      appendLog(
        'ok',
        `#${message.attempt} 第 ${message.attempt} 次轮询成功（${message.ms}ms）${describe(message.data)}`,
      );
      break;

    case 'error':
      appendLog(
        'error',
        `#${message.attempt} 第 ${message.attempt} 次轮询失败：${message.message}` +
          (message.fatal ? '（已达上限，停止）' : `，${message.nextDelay}ms 后重试`),
      );
      break;

    case 'done':
      appendLog('warn', `轮询结束：${message.reason}（共 ${message.attempts} 次请求）`);
      break;

    case 'state':
      setPollingState(message.polling, message.config);
      break;

    case 'log':
      appendLog('info', message.message);
      break;

    default: {
      const never: never = message;
      appendLog('error', `未知消息：${JSON.stringify(never)}`);
    }
  }
};

worker.onerror = (event: ErrorEvent): void => {
  appendLog('error', `worker 线程异常：${event.message}`);
  setPollingState(false);
};

worker.onmessageerror = (): void => {
  appendLog('error', '消息反序列化失败（onmessageerror）');
};

// ---------- 用户交互 ----------
els.start.addEventListener('click', () => {
  renderProgress(0);
  els.attempts.textContent = '0';
  send({ type: 'start', config: readConfig() });
});

els.stop.addEventListener('click', () => {
  send({ type: 'stop' });
});

els.clear.addEventListener('click', () => {
  els.log.innerHTML = '';
});

els.reset.addEventListener('click', () => {
  // 让 mock 服务端把任务进度清零，方便反复演示
  fetch('/api/task/reset', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then(() => {
      renderProgress(0);
      els.attempts.textContent = '0';
      appendLog('info', '服务端任务已重置');
    })
    .catch((error: unknown) => {
      appendLog('error', `重置失败：${error instanceof Error ? error.message : String(error)}`);
    });
});

// 页面关闭时释放线程
window.addEventListener('beforeunload', () => {
  send({ type: 'stop' });
  worker.terminate();
});

appendLog('info', '页面已加载，等待启动轮询');
