/**
 * 控制台彩色日志工具（TypeScript 版）
 *
 * 浏览器直接 ESM 引入即可：
 *   import { logger, createLogger } from './logger.js'
 *   import './index.js'   // 会自动挂载全局 Logger / log
 *   log.info('hello', { a: 1 })
 *   // 自定义徽章文案与配色
 *   logger.setLabel('info', '信息', { color: '#722ed1', text: '#722ed1' })  // 改全局配置
 *   logger.setLabels({ warn: '警告', error: '错误' })
 *   logger.label('info', '信息', { color: '#722ed1' }).info('只影响这一条') // 不改全局配置
 *
 * 内置样式：trace / debug / log(普通) / info / success / warn / error
 */

/** 日志级别，off 表示关闭全部输出 */
export type LogLevel = 'trace' | 'debug' | 'log' | 'info' | 'success' | 'warn' | 'error' | 'off'

/** 可输出的级别（去掉 off） */
export type PrintLevel = Exclude<LogLevel, 'off'>

/** 实际调用的 console 方法 */
export type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

/** 单个级别的配色 */
export interface LevelTheme {
  /** 徽章文字，如 INFO */
  label: string
  /** 徽章背景色 */
  color: string
  /** 正文文字色 */
  text: string
  /** Node 端 ANSI 前景色 */
  ansi: number
}

export interface LoggerOptions {
  /** 前缀，以深色徽章展示，用于区分不同模块 */
  prefix?: string
  /** 低于该级别的日志不输出，默认 trace */
  level?: LogLevel
  /** 总开关 */
  enabled?: boolean
  /** 是否在徽章前追加时间 */
  timestamp?: boolean
  /**
   * 覆盖主题（含徽章文案）
   * 如 { warn: { label: '警告', color: '#ff9800', text: '#d46b08' } }
   */
  styles?: Partial<Record<PrintLevel, Partial<LevelTheme>>>
}

export interface Logger {
  trace(...args: unknown[]): void
  debug(...args: unknown[]): void
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  success(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void

  /** 合并配置并从实例自身返回以便链式调用 */
  configure(options: LoggerOptions): Logger
  setLevel(level: LogLevel): Logger
  enable(): Logger
  disable(): Logger

  /**
   * 自定义某个级别的徽章文案与配色
   * @param level 级别，如 'info'
   * @param label 徽章文案，如 '信息'
   * @param style 可选配色，{ color: 徽章背景, text: 正文颜色, ansi: 终端色号 }
   */
  setLabel(level: PrintLevel, label: string, style?: Partial<Omit<LevelTheme, 'label'>>): Logger
  /** 批量自定义徽章文案，如 { info: '信息', warn: '警告' } */
  setLabels(labels: Partial<Record<PrintLevel, string>>): Logger

  /** 基于当前配置派生一个临时实例，后续改动不影响自身，用于一次性打印 */
  derive(options?: LoggerOptions): Logger
  /** 派生实例并把某级别的徽章临时改成自定义文案/配色，打印完即丢弃 */
  label(level: PrintLevel, text: string, style?: Partial<Omit<LevelTheme, 'label'>>): Logger

  /**
   * 分组，collapsed 为 true 时默认折叠
   */
  group(title: string, collapsed?: boolean, level?: PrintLevel): void
  groupEnd(): void
  table(data: unknown, columns?: string[]): void
  dir(value: unknown): void
  /** 打印调用栈，已过滤工具内部帧 */
  stack(message?: string): void

  /**
   * 计时，返回结束函数：
   * const end = logger.time('请求'); ... end()
   */
  time(label?: string): () => void
  timeEnd(label?: string): void
  count(label?: string): void
  countReset(label?: string): void
  /** 条件为假时才输出错误 */
  assert(condition: unknown, message?: string): void
  clear(): void
}

/** 数值越大越严重，用于级别过滤 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  log: 30,
  info: 30,
  success: 30,
  warn: 40,
  error: 50,
  off: 100
}

const CONSOLE_METHOD: Record<PrintLevel, ConsoleMethod> = {
  trace: 'log',
  debug: 'debug',
  log: 'log',
  info: 'log',
  success: 'log',
  warn: 'warn',
  error: 'error'
}

export const THEME: Record<PrintLevel, LevelTheme> = {
  trace: { label: 'TRACE', color: '#08979c', text: '#08979c', ansi: 36 },
  debug: { label: 'DEBUG', color: '#9254de', text: '#722ed1', ansi: 35 },
  log: { label: 'LOG', color: '#909399', text: '#303133', ansi: 37 },
  info: { label: 'INFO', color: '#409eff', text: '#1f6feb', ansi: 36 },
  success: { label: 'SUCCESS', color: '#52c41a', text: '#389e0d', ansi: 32 },
  warn: { label: 'WARN', color: '#e6a23c', text: '#d46b08', ansi: 33 },
  error: { label: 'ERROR', color: '#f56c6c', text: '#cf1322', ansi: 31 }
}

const PREFIX_COLOR = '#34495e'

/** 渲染方式：浏览器 CSS / 终端 ANSI / 纯文本 */
type RenderMode = 'css' | 'color' | 'plain'

type V8Error = typeof Error & {
  captureStackTrace?: (target: object, constructorOpt?: Function) => void
}

/** tsconfig 的 types 为空，这里按需取 process.stdout.isTTY 判断终端是否支持颜色 */
function detectRender(): RenderMode {
  const isDom =
    typeof window !== 'undefined' && typeof window.document !== 'undefined'
  if (isDom) return 'css'
  const stdout = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout
  return stdout?.isTTY ? 'color' : 'plain'
}

const RENDER: RenderMode = detectRender()

function stamp(): string {
  const date = new Date()
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3
  )}`
}

function badge(color: string, radius: string): string {
  return `background:${color};color:#fff;padding:2px 6px;border-radius:${radius};font-weight:600;`
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return value.name || 'anonymous'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // 循环引用等无法序列化的情况
    return String(value)
  }
}

function write(method: ConsoleMethod, args: unknown[]): void {
  const fn = console[method] ?? console.log
  // 用 Reflect 调用，避免直接解绑导致 this 丢失
  Reflect.apply(fn, console, args)
}

/** 取调用栈，stopAt 之上的工具内部帧会被裁掉 */
function captureStack(stopAt?: Function): string {
  const holder = new Error()
  const capture = (Error as V8Error).captureStackTrace
  if (capture && stopAt) capture(holder, stopAt)
  const lines = (holder.stack ?? '').split('\n')
  // 丢弃首行的 Error 标题，只保留 at 开头的帧
  return lines.filter((line, index) => index !== 0 || /^\s*at\s/.test(line)).join('\n')
}

type StyleMap = Partial<Record<PrintLevel, Partial<LevelTheme>>>

/** 浅拷贝主题配置，避免派生实例与父实例共用同一个对象 */
function cloneStyles(base?: StyleMap): StyleMap | undefined {
  if (!base) return undefined
  const out: StyleMap = {}
  for (const level of Object.keys(base) as PrintLevel[]) out[level] = { ...base[level] }
  return out
}

/** 按级别合并主题配置，未覆盖的级别保留原样 */
function mergeStyles(base: StyleMap | undefined, extra: StyleMap | undefined): StyleMap {
  const out: StyleMap = { ...base }
  for (const level of Object.keys(extra ?? {}) as PrintLevel[]) {
    out[level] = { ...out[level], ...extra?.[level] }
  }
  return out
}

export function createLogger(
  prefixOrOptions?: string | LoggerOptions,
  options?: LoggerOptions
): Logger {
  const conf: Required<Omit<LoggerOptions, 'styles'>> & Pick<LoggerOptions, 'styles'> = {
    prefix: '',
    level: 'trace',
    enabled: true,
    timestamp: false,
    styles: undefined
  }

  if (typeof prefixOrOptions === 'string') {
    conf.prefix = prefixOrOptions
  } else if (prefixOrOptions) {
    Object.assign(conf, prefixOrOptions)
  }
  if (options) Object.assign(conf, options)

  function themeOf(level: PrintLevel): LevelTheme {
    return { ...THEME[level], ...conf.styles?.[level] }
  }

  function allowed(level: PrintLevel): boolean {
    if (!conf.enabled) return false
    const current = LEVEL_WEIGHT[conf.level] ?? LEVEL_WEIGHT.trace
    return LEVEL_WEIGHT[level] >= current
  }

  /** 统一输出口 */
  function paint(level: PrintLevel, args: unknown[]): void {
    if (!allowed(level)) return
    const theme = themeOf(level)
    const rest = args.slice(1)

    if (RENDER !== 'css') {
      const head = [
        ...(conf.timestamp ? [stamp()] : []),
        ...(conf.prefix ? [`[${conf.prefix}]`] : []),
        `[${theme.label}]`
      ].join(' ')
      const line = `${head} ${toText(args[0])}`
      write(
        CONSOLE_METHOD[level],
        [RENDER === 'color' ? `\x1b[${theme.ansi}m${line}\x1b[0m` : line, ...rest]
      )
      return
    }

    const tokens: string[] = []
    const styles: string[] = []

    if (conf.timestamp) {
      tokens.push(`%c${stamp()}`)
      styles.push('color:#909399;font-size:11px;')
    }
    if (conf.prefix) {
      tokens.push(`%c ${conf.prefix} `)
      styles.push(badge(PREFIX_COLOR, '3px 0 0 3px'))
    }
    tokens.push(`%c ${theme.label} `)
    styles.push(badge(theme.color, conf.prefix ? '0 3px 3px 0' : '3px'))
    tokens.push(`%c ${toText(args[0])}`)
    styles.push(`color:${theme.text};font-weight:600;`)

    write(CONSOLE_METHOD[level], [tokens.join(' '), ...styles, ...rest])
  }

  function make(level: PrintLevel): (...args: unknown[]) => void {
    return (...args: unknown[]): void => paint(level, args)
  }

  const counters = new Map<string, number>()

  const logger: Logger = {
    trace: make('trace'),
    debug: make('debug'),
    log: make('log'),
    info: make('info'),
    success: make('success'),
    warn: make('warn'),
    error: make('error'),

    configure: (opts: LoggerOptions): Logger => {
      Object.assign(conf, opts)
      return logger
    },
    setLevel: (level: LogLevel): Logger => {
      conf.level = level
      return logger
    },
    enable: (): Logger => {
      conf.enabled = true
      return logger
    },
    disable: (): Logger => {
      conf.enabled = false
      return logger
    },

    setLabel: (
      level: PrintLevel,
      label: string,
      style?: Partial<Omit<LevelTheme, 'label'>>
    ): Logger => {
      conf.styles = {
        ...conf.styles,
        [level]: { ...conf.styles?.[level], label, ...style }
      }
      return logger
    },

    setLabels: (labels: Partial<Record<PrintLevel, string>>): Logger => {
      const next: Partial<Record<PrintLevel, Partial<LevelTheme>>> = { ...conf.styles }
      for (const level of Object.keys(labels) as PrintLevel[]) {
        const label = labels[level]
        if (label === undefined) continue
        next[level] = { ...next[level], label }
      }
      conf.styles = next
      return logger
    },

    derive: (options?: LoggerOptions): Logger => {
      // 复制一份 styles，保证派生实例后续改动不会回流到自身
      const cloned = cloneStyles(conf.styles)
      const merged: LoggerOptions = {
        prefix: conf.prefix,
        level: conf.level,
        enabled: conf.enabled,
        timestamp: conf.timestamp,
        styles: cloned,
        ...options
      }
      // options.styles 按级别与既有配置做浅合并，未覆盖的级别保留原样
      if (options?.styles) merged.styles = mergeStyles(cloned, options.styles)
      return createLogger(merged)
    },

    label: (
      level: PrintLevel,
      text: string,
      style?: Partial<Omit<LevelTheme, 'label'>>
    ): Logger => logger.derive().setLabel(level, text, style),

    group: (title: string, collapsed = false, level: PrintLevel = 'log'): void => {
      if (!conf.enabled) return
      paint(level, [title])
      if (collapsed && console.groupCollapsed) console.groupCollapsed()
      else if (console.group) console.group()
    },
    groupEnd: (): void => {
      console.groupEnd()
    },

    table: (data: unknown, columns?: string[]): void => {
      if (!conf.enabled) return
      paint('log', ['表格数据如下'])
      if (columns) console.table(data, columns)
      else console.table(data)
    },
    dir: (value: unknown): void => {
      if (!conf.enabled) return
      console.dir(value)
    },

    stack: (message?: string): void => {
      if (!allowed('trace')) return
      paint('trace', [message ?? '调用栈'])
      write(CONSOLE_METHOD.trace, [captureStack(logger.stack)])
    },

    time: (label = 'timer'): (() => void) => {
      const key = conf.prefix ? `${conf.prefix}:${label}` : label
      if (console.time) console.time(key)
      let ended = false
      return (): void => {
        if (ended) return
        ended = true
        if (console.timeEnd) console.timeEnd(key)
      }
    },
    timeEnd: (label = 'timer'): void => {
      const key = conf.prefix ? `${conf.prefix}:${label}` : label
      console.timeEnd(key)
    },

    count: (label = 'count'): void => {
      const next = (counters.get(label) ?? 0) + 1
      counters.set(label, next)
      paint('log', [`${label}: ${next}`])
    },
    countReset: (label = 'count'): void => {
      counters.delete(label)
    },

    assert: (condition: unknown, message?: string): void => {
      if (condition) return
      paint('error', [`断言失败: ${message ?? String(condition)}`])
    },

    clear: (): void => {
      console.clear()
    }
  }

  // trace 额外带上调用栈，堆栈里的工具内部帧已过滤
  logger.trace = (...args: unknown[]): void => {
    if (!allowed('trace')) return
    paint('trace', args)
    write(CONSOLE_METHOD.trace, [captureStack(logger.trace)])
  }

  return logger
}

/** 开箱即用的默认实例 */
export const logger: Logger = createLogger()

declare global {
  interface Window {
    Logger?: Logger
    log?: Logger
  }
}

/**
 * 挂载到全局，方便在没有 import 的 html 内联脚本里直接 log.info()
 */
export function mountGlobal(force = false): Logger {
  const scope = globalThis as typeof globalThis & { Logger?: Logger; log?: Logger }
  if (!scope.Logger || force) scope.Logger = logger
  if (!scope.log || force) scope.log = logger
  return logger
}

export function unmountGlobal(): void {
  const scope = globalThis as typeof globalThis & { Logger?: Logger; log?: Logger }
  delete scope.Logger
  delete scope.log
}
