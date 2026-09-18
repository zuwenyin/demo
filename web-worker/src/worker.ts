/**
 * worker 线程：负责所有网络请求（fetch）+ 轮询调度。
 *
 * 为什么要放到 worker？
 * - 轮询是长生命周期任务，放主线程会持续占用主线程的空闲时间片；
 * - 大量 JSON 解析 / 数据处理会阻塞渲染；
 * - worker 里可以随意 setTimeout 而不用担心页面切后台被节流影响主线程任务。
 *
 * 注意：worker 是独立线程，不能访问 document / window，只能通过 postMessage 与主线程通信。
 */
import type { PollConfig, PollResult, WorkerInMessage, WorkerOutMessage } from './types.js';

/**
 * 这里只声明 worker 场景真正用到的 API。
 * 直接把 self 断言成 DedicatedWorkerGlobalScope 需要引入 lib.webworker，
 * 而 lib.webworker 与 lib.dom 同时引入会产生大量重复声明冲突，所以用最小接口描述。
 */
interface WorkerScope {
  postMessage(message: WorkerOutMessage): void;
  onmessage: ((event: MessageEvent<WorkerInMessage>) => void) | null;
}

const ctx = self as unknown as WorkerScope;

const DEFAULT_CONFIG: PollConfig = {
  url: '/api/task/status',
  interval: 1500,
  timeout: 5000,
  maxAttempts: 20,
  backoffFactor: 1.6,
};

/** 最大退避倍数，避免无限增长 */
const MAX_BACKOFF_MULTIPLIER = 8;

let config: PollConfig = { ...DEFAULT_CONFIG };
let polling = false;
let attempt = 0;
let failStreak = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;

const post = (message: WorkerOutMessage): void => ctx.postMessage(message);

function emitState(): void {
  post({ type: 'state', polling, config: { ...config } });
}

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(delay: number): void {
  clearTimer();
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delay);
}

/** 单次请求：带超时中断 + no-store 防止浏览器缓存导致拿到旧数据 */
async function requestOnce(): Promise<{ data: PollResult; ms: number }> {
  controller = new AbortController();
  const timeoutId = setTimeout(() => controller?.abort(), config.timeout);
  const startedAt = Date.now();

  try {
    const response = await fetch(config.url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'x-poll-from': 'web-worker' },
    });

    const ms = Date.now() - startedAt;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return { data: (await response.json()) as PollResult, ms };
  } finally {
    clearTimeout(timeoutId);
    controller = null;
  }
}

function finish(reason: string, data?: PollResult): void {
  polling = false;
  clearTimer();
  post({ type: 'done', attempts: attempt, reason, data });
  emitState();
}

/** 一次轮询：请求 -> 上报结果 -> 决定下一次调度 */
async function tick(): Promise<void> {
  if (!polling) return;

  attempt += 1;
  const currentAttempt = attempt;

  try {
    const { data, ms } = await requestOnce();
    // 请求期间被 stop() 了，直接丢弃这次结果
    if (!polling) return;

    failStreak = 0;
    post({ type: 'result', attempt: currentAttempt, ms, data });

    if (data.status === 'done' || data.status === 'failed') {
      finish(`任务到达终态：${data.status}`, data);
      return;
    }
    schedule(config.interval);
  } catch (error) {
    // 被 stop() 触发的 abort 不算失败
    if (!polling) return;

    const message = error instanceof Error ? error.message : String(error);
    failStreak += 1;

    const fatal = currentAttempt >= config.maxAttempts;
    const nextDelay = fatal
      ? 0
      : Math.round(
          Math.min(
            config.interval * config.backoffFactor ** (failStreak - 1),
            config.interval * MAX_BACKOFF_MULTIPLIER,
          ),
        );

    post({ type: 'error', attempt: currentAttempt, message, nextDelay, fatal });

    if (fatal) {
      finish(`已达到最大请求次数 ${config.maxAttempts}`);
      return;
    }
    // 指数退避重试
    schedule(nextDelay);
  }
}

function start(next?: Partial<PollConfig>): void {
  if (next) config = { ...config, ...next };

  if (polling) {
    post({ type: 'log', message: '已在轮询中，忽略本次 start' });
    return;
  }

  polling = true;
  attempt = 0;
  failStreak = 0;
  post({
    type: 'log',
    message: `开始轮询 ${config.url}（间隔 ${config.interval}ms / 超时 ${config.timeout}ms / 最多 ${config.maxAttempts} 次）`,
  });
  emitState();
  void tick();
}

function stop(reason: string): void {
  if (!polling) {
    post({ type: 'log', message: '当前没有正在进行的轮询' });
    return;
  }
  polling = false;
  clearTimer();
  controller?.abort();
  post({ type: 'done', attempts: attempt, reason });
  emitState();
}

ctx.onmessage = (event: MessageEvent<WorkerInMessage>): void => {
  const message = event.data;

  switch (message.type) {
    case 'start':
      start(message.config);
      break;
    case 'stop':
      stop('主线程主动停止');
      break;
    case 'config':
      config = { ...config, ...message.config };
      post({ type: 'log', message: `配置已更新：${JSON.stringify(message.config)}` });
      emitState();
      break;
    default: {
      // 穷尽检查：新增消息类型时这里会报编译错误
      const never: never = message;
      post({ type: 'log', message: `未知消息：${JSON.stringify(never)}` });
    }
  }
};

// 通知主线程 worker 已就绪（主线程可以据此再发指令，避免竞态）
post({ type: 'log', message: 'worker 线程已启动' });
