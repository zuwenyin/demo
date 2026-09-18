/**
 * 上游数据接口（CDN）访问：常量、请求头与请求函数
 *
 * 三个脚本（fetch-exam-data / simulate-answer / build-submit-payload）共用这里的常量与请求逻辑，
 * 接口地址、请求头或超时策略有变动时只需改这一处。
 */
import { toPositiveInt } from './exam-utils.js'
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

/** GET 上游并返回完整响应；非 2xx 不抛错，由调用方判断（与列表页 axios 行为一致） */
export async function fetchUpstream(input: string, t?: string): Promise<UpstreamResponse> {
  const url = resolveUpstreamUrl(input, t)
  const startedAt = Date.now()

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

  return {
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
