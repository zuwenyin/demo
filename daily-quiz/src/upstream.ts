/**
 * 上游数据接口（CDN）访问：常量、请求头与请求函数
 *
 * 三个脚本（fetch-exam-data / simulate-answer / build-submit-payload）共用这里的常量与请求逻辑，
 * 接口地址、请求头或超时策略有变动时只需改这一处。
 */
import { toNonNegativeInt, toPositiveInt } from './exam-utils.js'
import { warn } from './terminal-style.js'
import type { ExamItem } from './exam-types.js'

/** 上游数据站点（CDN） */
export const UPSTREAM_ORIGIN = (process.env.UPSTREAM_ORIGIN ?? 'https://ehs30sfun-cdn.asymchem.com.cn').replace(/\/+$/, '')
/** 数据文件目录 */
export const DATA_DIR = '/exam-data'
/** 指针文件路径，返回 { "current": "exam_data_xxx.json" } */
export const POINTER_PATH = `${DATA_DIR}/exam_data_latest.json`
/** 单次请求超时时间（毫秒） */
export const REQUEST_TIMEOUT = toPositiveInt(process.env.REQUEST_TIMEOUT, 30_000)
/** t 参数的版本窗口，与前端一致：5 分钟 */
export const VERSION_WINDOW_MS = 5 * 60 * 1000
/** GET 失败的进程内重试次数（0 = 不重试）；只对网络错误 / 超时 / 5xx / 429 重试 */
export const UPSTREAM_RETRIES = toNonNegativeInt(process.env.UPSTREAM_RETRIES, 3)
/** 第 n 次重试前的等待时间（毫秒）；次数超出时取最后一档 */
const UPSTREAM_RETRY_DELAYS = [500, 1_000, 2_000]

/** 请求上游使用的 UA（默认与钉钉内嵌浏览器一致），数据接口与提交接口共用 */
export const UPSTREAM_USER_AGENT =
  process.env.UPSTREAM_USER_AGENT ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.5359.125 Safari/537.36 dingtalk-win/1.0.0 nw(0.14.7) DingTalk(7.6.45-RC.250214002) Mojo/1.0.0 NativeAppType(rc) Channel/201200 Architecture/x86_64'

/** 数据接口请求头，取自浏览器/钉钉内嵌浏览器的抓包结果 */
export const DATA_REQUEST_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: `${UPSTREAM_ORIGIN}/exam-list.html`,
  'User-Agent': UPSTREAM_USER_AGENT,
}

/** 与前端一致的 t 参数：5 分钟粒度的版本号 */
export function currentVersion(): string {
  return String(Math.floor(Date.now() / VERSION_WINDOW_MS))
}

/** 把接口路径或完整 URL 补全，并按需附加 t 参数 */
export function resolveUpstreamUrl(input: string, t?: string): string {
  const base = input.startsWith('http://') || input.startsWith('https://')
    ? input
    : `${UPSTREAM_ORIGIN}${input.startsWith('/') ? input : `/${input}`}`
  if (!t) return base

  const url = new URL(base)
  url.searchParams.set('t', t)
  return url.toString()
}

/** 上游响应（含状态、响应头与原始响应体） */
export interface UpstreamResponse {
  method: 'GET'
  url: string
  status: number
  statusText: string
  ok: boolean
  elapsedMs: number
  bytes: number
  headers: Record<string, string>
  body: string
}

/** 取完整错误链：undici 把真实原因藏在 error.cause / AggregateError.errors 里 */
export function describeError(error: unknown, depth = 0): string {
  if (!error || depth > 3) return ''
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  const cause = (error as { cause?: unknown }).cause
  if (cause) parts.push(describeError(cause, depth + 1))
  const errors = (error as { errors?: unknown[] }).errors
  if (Array.isArray(errors) && errors[0]) parts.push(describeError(errors[0], depth + 1))
  return parts.filter(Boolean).join(' ← ')
}

/** 网络层 / 超时类错误才重试；业务失败重试没有意义 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TimeoutError') return true // AbortSignal.timeout
  if (error.message === 'fetch failed') return true // undici 网络层（真实原因在 cause 里）
  const code = (error as { cause?: { code?: string } }).cause?.code ?? ''
  return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(
    code,
  )
}

/** HTTP 层可重试状态：限流与 5xx */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

/** 等待指定毫秒（重试退避用） */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 第 attempt 次重试前的等待时间（attempt 从 0 开始） */
function retryDelayMs(attempt: number): number {
  return UPSTREAM_RETRY_DELAYS[Math.min(attempt, UPSTREAM_RETRY_DELAYS.length - 1)] ?? 500
}

/**
 * GET 上游并返回完整响应；非 2xx 不抛错，由调用方判断（与列表页 axios 行为一致）
 *
 * 网络层抖动（实测该 CDN 偶发 ECONNRESET / TLS 握手被重置）会重试 retries 次，
 * 只对网络错误 / 超时 / 5xx / 429 重试；重试耗尽后把最后一次错误原样抛出。
 */
export async function fetchUpstream(
  input: string,
  t?: string,
  retries: number = UPSTREAM_RETRIES,
): Promise<UpstreamResponse> {
  const url = resolveUpstreamUrl(input, t)
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAt = Date.now()
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: DATA_REQUEST_HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        redirect: 'follow',
      })
      const body = await response.text()
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name] = value
      })

      const result: UpstreamResponse = {
        method: 'GET',
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(body),
        headers,
        body,
      }

      // 5xx / 429 之外的状态码（含正常 200）直接返回，由调用方判断
      if (result.ok || !isRetryableStatus(result.status) || attempt >= retries) return result
      const wait = retryDelayMs(attempt)
      console.warn(warn(`HTTP ${result.status} ${url}，${wait}ms 后第 ${attempt + 1}/${retries} 次重试`))
      await delay(wait)
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableError(error)) throw error
      const wait = retryDelayMs(attempt)
      console.warn(
        warn(`请求失败（${describeError(error)}），${wait}ms 后第 ${attempt + 1}/${retries} 次重试：${url}`),
      )
      await delay(wait)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** GET 上游并解析 JSON；非 2xx 直接抛错 */
export async function fetchUpstreamJson<T>(input: string, t?: string): Promise<T> {
  const result = await fetchUpstream(input, t)
  if (!result.ok) throw new Error(`请求失败 ${result.status} ${result.url}`)
  return JSON.parse(result.body) as T
}

export interface LoadedExamData<T> {
  current: string
  t: string
  pointerUrl: string
  dataUrl: string
  data: T[]
}

/** 两步拉取：指针文件 -> 数据文件，返回 current、t、两个 URL 与试卷数组 */
export async function loadExamData<T = ExamItem>(options: { t?: string } = {}): Promise<LoadedExamData<T>> {
  const t = options.t ?? currentVersion()
  const pointerUrl = `${UPSTREAM_ORIGIN}${POINTER_PATH}`
  const pointer = await fetchUpstreamJson<{ current?: unknown }>(pointerUrl)
  const current = pointer?.current
  if (typeof current !== 'string' || current.length === 0) {
    throw new Error(`指针文件里没有 current 字段：${JSON.stringify(pointer).slice(0, 120)}`)
  }

  const dataUrl = `${UPSTREAM_ORIGIN}${DATA_DIR}/${current}?t=${t}`
  return { current, t, pointerUrl, dataUrl, data: await fetchUpstreamJson<T[]>(dataUrl) }
}
