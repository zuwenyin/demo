/**
 * 终端输出样式：ANSI 加粗 / 颜色 / 反白
 *
 * 开启规则（与社区惯例一致）：
 *   1) 设置了 NO_COLOR            -> 关闭
 *   2) 设置了 FORCE_COLOR（非 0） -> 强制开启
 *   3) 否则仅当 stdout 是 TTY 时开启（输出重定向到文件时保持纯文本，避免 ANSI 乱码）
 */

export const colorEnabled: boolean = (() => {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true
  return Boolean(process.stdout.isTTY)
})()

const wrap =
  (open: string, close: string) =>
  (text: string): string =>
    colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text

export const style = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('31', '39'),
  green: wrap('32', '39'),
  yellow: wrap('33', '39'),
  blue: wrap('34', '39'),
  magenta: wrap('35', '39'),
  cyan: wrap('36', '39'),
  gray: wrap('90', '39'),
  /** 反白：加粗 + 黑字 + 青底 */
  highlight: wrap('1;30;46', '0'),
} as const

/** 步骤大标题：`▶ 1/5 指针文件 ────────────────`（加粗青色 + 灰色引导线） */
export function heading(title: string): string {
  return `\n${style.bold(style.cyan(`▶ ${title}`))} ${style.gray('─'.repeat(Math.max(8, 72 - title.length)))}`
}

/** 小节标题（加粗） */
export function subheading(text: string): string {
  return style.bold(style.cyan(text))
}

/** 字段名（灰色加粗） */
export function label(text: string): string {
  return style.bold(style.gray(text))
}

/** 成功文本 */
export function ok(text: string): string {
  return style.bold(style.green(text))
}

/** 失败文本 */
export function fail(text: string): string {
  return style.bold(style.red(text))
}

/** 警告文本 */
export function warn(text: string): string {
  return style.bold(style.yellow(text))
}

/** 强调文本（青） */
export function info(text: string): string {
  return style.bold(style.cyan(text))
}

/** 次要文本（灰） */
export function muted(text: string): string {
  return style.gray(text)
}

/** 状态徽标，如 [OK] / [FAIL] / [WARN] / [INFO] */
export function badge(kind: 'ok' | 'warn' | 'fail' | 'info', text: string): string {
  const paint = { ok: style.green, warn: style.yellow, fail: style.red, info: style.cyan }[kind]
  return style.bold(paint(`[${text}]`))
}
