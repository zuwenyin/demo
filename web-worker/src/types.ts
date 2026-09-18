/**
 * 主线程 <-> worker 线程之间共享的消息协议与数据类型。
 * 两个线程都只依赖类型（type-only import），编译后不会产生任何运行时代码。
 */

/** 轮询配置 */
export interface PollConfig {
  /** 轮询地址，默认 '/api/task/status' */
  url: string;
  /** 正常轮询间隔（ms） */
  interval: number;
  /** 单次请求超时时间（ms） */
  timeout: number;
  /** 最大请求次数，超过后判定为致命失败并停止轮询 */
  maxAttempts: number;
  /** 失败退避系数：下次延迟 = interval * backoffFactor^(连续失败次数-1) */
  backoffFactor: number;
}

/** 接口返回的任务状态 */
export interface PollResult {
  taskId: string;
  /** 0 ~ 100 */
  progress: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  message?: string;
  serverTime: string;
}

/** 主线程 -> worker */
export type WorkerInMessage =
  /** 开始轮询，可携带新配置 */
  | { type: 'start'; config?: Partial<PollConfig> }
  /** 停止轮询 */
  | { type: 'stop' }
  /** 运行中动态修改配置（下一次调度生效） */
  | { type: 'config'; config: Partial<PollConfig> };

/** worker -> 主线程 */
export type WorkerOutMessage =
  /** 一次成功的轮询结果 */
  | { type: 'result'; attempt: number; ms: number; data: PollResult }
  /** 一次失败的轮询（不是结束信号） */
  | { type: 'error'; attempt: number; message: string; nextDelay: number; fatal: boolean }
  /** 轮询结束：任务终态 / 达到最大次数 / 主动 stop */
  | { type: 'done'; attempts: number; reason: string; data?: PollResult }
  /** worker 内部状态变更（开始/停止） */
  | { type: 'state'; polling: boolean; config: PollConfig }
  /** 纯文本日志 */
  | { type: 'log'; message: string };
