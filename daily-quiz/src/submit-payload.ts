/**
 * 提交请求体的构建与打印（复刻「题目详情.html」的提交逻辑，供各脚本复用）
 *
 *   1) 明文 = { ExaminationId, Code, Answers: [{ QuestionId, AnswerContent }] }
 *      - ExaminationId = 试卷 id；Code = base64(工号)
 *      - AnswerContent 按正确答案反推：单选/多选 -> 内部字母；判断题 -> "对"/"错"；填空/简答 -> 文本
 *   2) 明文 JSON.stringify -> encodeURIComponent -> SM2 加密（cipherMode=1，C1C3C2，hex）
 *   3) 打印明文、两种密文格式、两种 POST body 形态，并用私钥做本地解密自检（不发请求）
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
// @ts-ignore sm-crypto 未提供类型声明文件
import { sm2 } from 'sm-crypto'
import { decodeTolerant, parseJsonTolerant, questionTypeName, stripHtmlKeepLines } from './exam-utils.js'
import type { SubmitExam, SubmitQuestion } from './exam-types.js'
import { UPSTREAM_ORIGIN, UPSTREAM_USER_AGENT } from './upstream.js'
import { fail, heading, label, ok, subheading, warn } from './terminal-style.js'

export type { SubmitExam, SubmitQuestion } from './exam-types.js'

/** 提交接口路径 */
export const SUBMIT_PATH = '/api/StudentExam/SubmitByHtml'

export interface EnvConfig {
  VITE_API_URL?: string
  VITE_SM_PUBLIC_KEY?: string
  VITE_SM_PRIVATE_KEY?: string
  /** config.js 里配置的工号列表（数组写法，或用逗号分隔的字符串），支持批量提交 */
  QUIZ_JOB_NUMBERS?: string[]
  /** 答题范围：public（只答公共题）/ custom（只答 QUIZ_CATEGORIES）/ all（当天该厂区全部） */
  QUIZ_SCOPE?: string
  /** 仅 QUIZ_SCOPE = "custom" 时生效 */
  QUIZ_CATEGORIES?: string[]
  /** 仅 QUIZ_SCOPE = "public" 时生效，默认「公共题」 */
  QUIZ_PUBLIC_CATEGORY?: string
  /** 厂区，默认 TJ2 */
  QUIZ_FACTORY?: string
  /** 是否只处理 startTime 为当天的试卷，默认 true */
  QUIZ_ONLY_TODAY?: boolean
}

export interface SubmitPayload {
  answers: Array<{ QuestionId: string | number; AnswerContent: string }>
  plainJson: string
  urlEncoded: string
  /** 与页面 SmCryptoV2（iiiii.js）一致的格式：C1 带 04 前缀 */
  cipherWithPrefix: string
  /** sm-crypto 0.5.7 的原始输出：C1 不带 04 前缀 */
  cipherWithoutPrefix: string
}

/* -------------------------------- 配置读取 -------------------------------- */

/** 把逗号/分号/顿号/空格分隔的字符串切成列表 */
function splitList(value: string): string[] {
  return value
    .split(/[,;、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** 解析 config.js 里的 window.__env__（只提取键值，不执行文件中的代码） */
export async function loadEnvConfig(configPath: string): Promise<EnvConfig> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    throw new Error(`读不到配置文件：${configPath}`)
  }

  const env: EnvConfig = {}
  let matched: RegExpExecArray | null

  // 字符串值：KEY: "value"
  const pattern = /([A-Za-z_$][\w$]*)\s*:\s*["']([^"']*)["']/g
  while ((matched = pattern.exec(text)) !== null) {
    const key = matched[1] as string
    const value = matched[2] as string
    if (key === 'VITE_API_URL') env.VITE_API_URL = value
    else if (key === 'VITE_SM_PUBLIC_KEY') env.VITE_SM_PUBLIC_KEY = value
    else if (key === 'VITE_SM_PRIVATE_KEY') env.VITE_SM_PRIVATE_KEY = value
    else if (key === 'QUIZ_JOB_NUMBERS') env.QUIZ_JOB_NUMBERS = splitList(value)
    else if (key === 'QUIZ_SCOPE') env.QUIZ_SCOPE = value
    else if (key === 'QUIZ_CATEGORIES') env.QUIZ_CATEGORIES = splitList(value)
    else if (key === 'QUIZ_PUBLIC_CATEGORY') env.QUIZ_PUBLIC_CATEGORY = value
    else if (key === 'QUIZ_FACTORY') env.QUIZ_FACTORY = value
  }

  // 数组值：KEY: ["A", "B"]
  const arrayPattern = /([A-Za-z_$][\w$]*)\s*:\s*\[([^\]]*)\]/g
  while ((matched = arrayPattern.exec(text)) !== null) {
    const key = matched[1] as string
    const inner = matched[2] as string
    const values = inner
      .split(',')
      .map((item) => item.trim().replace(/^["']|["']$/g, '').trim())
      .filter((item) => item.length > 0)
    if (key === 'QUIZ_JOB_NUMBERS') env.QUIZ_JOB_NUMBERS = values
    else if (key === 'QUIZ_CATEGORIES') env.QUIZ_CATEGORIES = values
  }

  // 布尔值：KEY: true / false
  const booleanPattern = /([A-Za-z_$][\w$]*)\s*:\s*(true|false)\b/g
  while ((matched = booleanPattern.exec(text)) !== null) {
    if (matched[1] === 'QUIZ_ONLY_TODAY') env.QUIZ_ONLY_TODAY = matched[2] === 'true'
  }

  if (!env.VITE_SM_PUBLIC_KEY) throw new Error(`配置文件里没有 VITE_SM_PUBLIC_KEY：${configPath}`)
  return env
}

/** 打印配置摘要 */
export function printConfig(env: EnvConfig, configPath: string): void {
  const publicKey = env.VITE_SM_PUBLIC_KEY as string
  const privateKey = env.VITE_SM_PRIVATE_KEY ?? ''
  console.log(`${label('config.js')}        : ${configPath}`)
  console.log(`${label('VITE_API_URL')}     : ${env.VITE_API_URL ?? '-'}`)
  console.log(`${label('SM2 公钥')}         : ${publicKey}`)
  console.log(`${label('     公钥长度')}    : ${publicKey.length} 个 hex 字符（${publicKey.startsWith('04') ? '带 04 前缀' : '无 04 前缀'}）`)
  console.log(
    `${label('SM2 私钥(自检用)')} : ${privateKey ? `${privateKey.slice(0, 8)}...${privateKey.slice(-4)}（${privateKey.length} hex）` : '（未提供，跳过自检）'}`,
  )
  const jobNumbers = env.QUIZ_JOB_NUMBERS ?? []
  console.log(
    `${label('工号配置')}         : ${
      jobNumbers.length > 0 ? `${jobNumbers.join(', ')}（共 ${jobNumbers.length} 个，来自 QUIZ_JOB_NUMBERS）` : '未配置（用 --code 或环境变量 QUIZ_CODE 指定）'
    }`,
  )
  const scope = env.QUIZ_SCOPE ?? 'public'
  console.log(
    `${label('答题范围')}         : ${scope}${
      scope.toLowerCase() === 'custom' ? `（类别：${(env.QUIZ_CATEGORIES ?? []).join('、') || '未配置'}）` : ''
    }`,
  )
  console.log(`${label('厂区')}             : ${env.QUIZ_FACTORY ?? DEFAULT_FACTORY}`)
  console.log(`${label('仅当天')}           : ${env.QUIZ_ONLY_TODAY ?? true}`)
  console.log(`${label('提交地址')}         : ${env.VITE_API_URL ?? ''}${SUBMIT_PATH}`)
  console.log(`${label('Content-Type')}     : application/json`)
}

/* ---------------------------------- 工具 ---------------------------------- */

/** 与页面 btoa(unescape(encodeURIComponent(str))) 等价的 UTF-8 base64 */
export function toBase64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64')
}

/**
 * 终端交互式读取工号：提示 -> 输入 -> 回车确认 -> 回显确认结果 -> 继续
 * 输入 q 取消；输入为空会重新提示
 */
export async function promptJobNumber(): Promise<string> {
  if (!process.stdin.isTTY) {
    console.log('提示：当前 stdin 不是终端，无法交互输入，将直接读取标准输入（可用 --code <工号> 指定）')
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      let answer: string
      try {
        answer = (await rl.question('请输入工号（输入后按回车确认，输入 q 取消）：')).trim()
      } catch {
        throw new Error('读取输入失败：请改用 --code <工号> 或环境变量 QUIZ_CODE 提供')
      }

      if (answer === 'q' || answer === 'Q') throw new Error('已取消输入工号')
      if (answer.length > 0) {
        console.log(`已确认工号：${answer}    Code(提交体里的值) = ${toBase64(answer)}`)
        return answer
      }
      console.log('工号不能为空，请重新输入。')
    }
  } finally {
    rl.close()
  }
}

export interface JobTarget {
  /** 明文工号（用 --code-base64 直接给编码值时为空） */
  jobNumber: string | null
  /** 提交体里的 Code */
  code: string
  /** 来源说明 */
  codeSource: string
}

/**
 * 确定本次要提交的工号列表，优先级：
 *   1) --code-base64                 直接给编码后的 Code
 *   2) --code / 环境变量 QUIZ_CODE    单个工号（临时覆盖 config 配置）
 *   3) config.js 的 QUIZ_JOB_NUMBERS  可配置多个工号 -> 逐个提交
 *   4) 终端交互输入                    仅当前三者都没有时才提示
 */
export async function resolveJobNumbers(options: {
  code?: string
  codeBase64?: string
  /** config.js 里配置的工号列表 */
  configured?: string[]
  /** 是否允许交互输入，默认允许；置 false 时缺少工号直接抛错 */
  interactive?: boolean
}): Promise<JobTarget[]> {
  if (options.codeBase64) {
    return [{ jobNumber: null, code: options.codeBase64, codeSource: '--code-base64 直接传入' }]
  }

  const fromArg = options.code ?? process.env.QUIZ_CODE
  if (fromArg) {
    return [{ jobNumber: fromArg, code: toBase64(fromArg), codeSource: `命令行/环境变量：工号 "${fromArg}"` }]
  }

  const configured = options.configured ?? []
  if (configured.length > 0) {
    return configured.map((jobNumber) => ({
      jobNumber,
      code: toBase64(jobNumber),
      codeSource: `config.js 的 QUIZ_JOB_NUMBERS（共 ${configured.length} 个工号）`,
    }))
  }

  if (options.interactive === false) {
    throw new Error('缺少工号：请在 config.js 里配置 QUIZ_JOB_NUMBERS，或用 --code / 环境变量 QUIZ_CODE 提供')
  }

  const input = await promptJobNumber()
  return [{ jobNumber: input, code: toBase64(input), codeSource: `终端交互输入：工号 "${input}"` }]
}

/* -------------------------------- 答题范围 -------------------------------- */

/** 默认的公共题类别名 */
export const DEFAULT_PUBLIC_CATEGORY = '公共题'
/** 默认厂区 */
export const DEFAULT_FACTORY = 'TJ2'

export type QuizScope = 'public' | 'custom' | 'all'

export interface ScopeConfig {
  scope: QuizScope
  /** 需要匹配的题目类别；空数组表示不按类别过滤（all） */
  categories: string[]
  publicCategory: string
  /** 是否只处理 startTime 为当天的试卷 */
  onlyToday: boolean
  factory: string
  /** 范围来源说明（用于打印） */
  source: string
}

/**
 * 解析答题范围，优先级：
 *   1) --detail-category        临时只答该类别（覆盖配置）
 *   2) config.js 的 QUIZ_SCOPE  public（默认）/ custom / all
 */
export function resolveScopeConfig(env: EnvConfig, overrides: { factory?: string; detailCategory?: string } = {}): ScopeConfig {
  const publicCategory = env.QUIZ_PUBLIC_CATEGORY ?? DEFAULT_PUBLIC_CATEGORY
  const factory = overrides.factory ?? env.QUIZ_FACTORY ?? DEFAULT_FACTORY
  const onlyToday = env.QUIZ_ONLY_TODAY ?? true
  const base = { publicCategory, factory, onlyToday }

  if (overrides.detailCategory) {
    return {
      ...base,
      scope: 'custom',
      categories: [overrides.detailCategory],
      source: `--detail-category ${overrides.detailCategory}（临时覆盖配置）`,
    }
  }

  const raw = (env.QUIZ_SCOPE ?? 'public').trim().toLowerCase()
  if (raw === 'all') {
    return { ...base, scope: 'all', categories: [], source: 'config.js 的 QUIZ_SCOPE = "all"（当天该厂区全部试卷）' }
  }
  if (raw === 'custom') {
    const categories = env.QUIZ_CATEGORIES ?? []
    return {
      ...base,
      scope: 'custom',
      categories,
      source: `config.js 的 QUIZ_SCOPE = "custom"（类别：${categories.length > 0 ? categories.join('、') : '未配置'}）`,
    }
  }
  return {
    ...base,
    scope: 'public',
    categories: [publicCategory],
    source: `config.js 的 QUIZ_SCOPE = "public"（类别：${publicCategory}）`,
  }
}

/* -------------------------------- 构建提交体 ------------------------------- */

/** 按正确答案反推 AnswerContent（复刻详情页对判断题的 A/B -> 对/错 转换） */
export function buildAnswerContent(question: SubmitQuestion): string {
  const correct = String(question.correctAnswer ?? '')
  if (question.questionType === 3) {
    if (correct === 'A') return '对'
    if (correct === 'B') return '错'
  }
  return correct
}

/** 组明文并加密 */
export function buildSubmitPayload(exam: SubmitExam, code: string, publicKey: string): SubmitPayload {
  const answers = (exam.questions ?? []).map((question) => ({
    QuestionId: question.id ?? 0,
    AnswerContent: buildAnswerContent(question),
  }))
  const plainJson = JSON.stringify({ ExaminationId: exam.id, Code: code, Answers: answers })
  const urlEncoded = encodeURIComponent(plainJson)
  const cipherFromLib = sm2.doEncrypt(urlEncoded, publicKey) as string
  // 页面 SmCryptoV2 输出的 C1 带 04 前缀，sm-crypto 0.5.7 会截掉，这里补回
  const cipherWithPrefix = cipherFromLib.startsWith('04') ? cipherFromLib : `04${cipherFromLib}`
  return { answers, plainJson, urlEncoded, cipherWithPrefix, cipherWithoutPrefix: cipherWithPrefix.slice(2) }
}

/** SM2 解密：带/不带 04 前缀都试（与页面 DecryptString 的处理一致），失败返回空串 */
function decryptTolerant(cipherText: string, privateKey: string): string {
  const candidates = cipherText.startsWith('04') ? [cipherText, cipherText.slice(2)] : [cipherText]
  for (const candidate of candidates) {
    const plain = sm2.doDecrypt(candidate, privateKey, 1) as string
    if (plain) return plain.trim()
  }
  return ''
}

/* ---------------------------------- 打印 ---------------------------------- */

export interface PrintSubmitOptions {
  title: string
  exam: SubmitExam
  code: string
  codeSource: string
  env: EnvConfig
  payload: SubmitPayload
  /** 精简模式：多工号批量提交时只打印关键信息，避免刷屏 */
  compact?: boolean
}

/** 打印提交请求体（明文 / 密文两种格式 / body 两种形态 / 本地自检） */
export function printSubmitPayload(options: PrintSubmitOptions): void {
  const { title, exam, code, codeSource, env, payload } = options

  // 批量提交（多个工号）时用精简模式，避免每个工号都刷几十行
  if (options.compact) {
    const checkKey = env.VITE_SM_PRIVATE_KEY ?? ''
    const checked = checkKey ? decryptTolerant(payload.cipherWithPrefix, checkKey) : ''
    console.log(`\n${subheading(title)}`)
    console.log(`  ${label('Code')} : ${code}（${codeSource}）`)
    console.log(`  ${label('明文')} : ${payload.plainJson}`)
    console.log(`  ${label('密文')} : ${payload.cipherWithPrefix}`)
    console.log(`  ${label('body')} : ${Buffer.byteLength(payload.cipherWithPrefix)} 字节（裸 hex 字符串）`)
    console.log(`  ${label('自检')} : ${checked === payload.urlEncoded ? ok('解密后与明文一致') : warn('未通过（缺少私钥或密文异常）')}`)
    return
  }

  const questions = exam.questions ?? []
  const first = questions[0]
  const privateKey = env.VITE_SM_PRIVATE_KEY ?? ''
  const submitUrl = `${env.VITE_API_URL ?? ''}${SUBMIT_PATH}`

  console.log(heading(title))
  console.log(`${label('试卷 id')}   : ${exam.id}`)
  console.log(`${label('试卷名称')}  : ${first?.questionName || exam.examinationName || '(无名称)'}`)
  console.log(`${label('厂区/类别')} : ${first?.factory ?? '-'} / ${first?.category ?? '-'}`)
  console.log(`${label('Code')}      : ${code}    （${codeSource}）`)
  console.log(`${label('题目数量')}  : ${questions.length}`)

  console.log(`\n${subheading('作答明细（按正确答案反推）')}`)
  questions.forEach((question, index) => {
    console.log(`  [${String(index + 1).padStart(2, '0')}] ${questionTypeName(question.questionType)}  题目 id=${question.id ?? '-'}`)
    console.log(`       题干          : ${stripHtmlKeepLines(question.questionText)}`)
    console.log(`       correctAnswer : ${JSON.stringify(question.correctAnswer ?? null)}  ->  AnswerContent = ${JSON.stringify(buildAnswerContent(question))}`)
  })

  console.log(`\n${subheading('明文（JSON.stringify 的原文）：')}`)
  console.log(payload.plainJson)
  console.log(`\n${subheading('（美化展示）')}`)
  console.log(JSON.stringify(JSON.parse(payload.plainJson), null, 2))

  console.log(`\n${subheading('encodeURIComponent 之后的明文：')}`)
  console.log(payload.urlEncoded)

  console.log(`\n${subheading('SM2 密文（hex，每次随机生成）：')}`)
  console.log(`格式 A（推荐，与页面 SmCryptoV2 / iiiii.js 一致，C1 带 04 前缀）：${payload.cipherWithPrefix.length} hex = ${payload.cipherWithPrefix.length / 2} 字节`)
  console.log(payload.cipherWithPrefix)
  console.log(`\n格式 B（sm-crypto 0.5.7 的原始输出，不带 04 前缀）：${payload.cipherWithoutPrefix.length} hex = ${payload.cipherWithoutPrefix.length / 2} 字节`)
  console.log(payload.cipherWithoutPrefix)
  console.log('\n两种格式只差开头 1 个字节（04 是未压缩点标识）；页面的 DecryptString 会按前两位判断，两种都能解。')

  const bodyRaw = payload.cipherWithPrefix
  const bodyJsonString = JSON.stringify(payload.cipherWithPrefix)
  console.log(`\n${subheading('POST body 的两种形态（基于格式 A）：')}`)
  console.log(`${label('形态 A（裸 hex 字符串）')}      : ${Buffer.byteLength(bodyRaw)} 字节`)
  console.log(`  ${bodyRaw.slice(0, 80)}...`)
  console.log(`${label('形态 B（JSON 字符串，带引号）')}: ${Buffer.byteLength(bodyJsonString)} 字节`)
  console.log(`  ${bodyJsonString.slice(0, 80)}...`)
  console.log(`\n${subheading('请求信息（下一步用这份密文真实提交）：')}`)
  console.log(`  ${label('POST')} ${submitUrl}`)
  console.log(`  ${label('Content-Type')}: application/json`)
  console.log(`  ${label('body')}: <上面两种形态之一>`)

  console.log(`\n${subheading('本地解密自检（未调用接口）：')}`)
  if (!privateKey) {
    console.log(`  ${warn('config.js 没有私钥，跳过自检')}`)
    return
  }
  const withPrefix = decryptTolerant(payload.cipherWithPrefix, privateKey)
  const withoutPrefix = decryptTolerant(payload.cipherWithoutPrefix, privateKey)
  console.log(`  ${label('格式 A（带 04 前缀）解密成功')} : ${withPrefix === payload.urlEncoded ? ok('true') : fail('false')}`)
  console.log(`  ${label('格式 B（不带 04 前缀）解密成功')} : ${withoutPrefix === payload.urlEncoded ? ok('true') : fail('false')}`)
  console.log(`  ${label('解密后与明文一致')} : ${decodeURIComponent(withPrefix) === payload.plainJson ? ok('true') : fail('false')}`)
  console.log(`  ${label('解密内容')}：${decodeURIComponent(withPrefix)}`)
}

/* -------------------------------- 提交请求 -------------------------------- */

/** 提交接口用的请求头（比页面 axios 多带 Referer / UA，模拟浏览器发起） */
const SUBMIT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: `${UPSTREAM_ORIGIN}/start-exam.html`,
  'User-Agent': UPSTREAM_USER_AGENT,
}

export interface SubmitResponseResult {
  url: string
  bodyMode: 'raw' | 'json'
  requestBytes: number
  status: number
  statusText: string
  ok: boolean
  elapsedMs: number
  headers: Record<string, string>
  rawBody: string
  /** 业务 code（响应不是规范化 JSON 时为 null） */
  code: number | null
  /** 解密后的 message */
  message: string | null
  errors: unknown
  /** 解密后的 result 文本 */
  resultText: string | null
  /** 解密后的 result 对象 */
  result: Record<string, unknown> | null
  alreadySubmitted: boolean
  isPassed: boolean | null
}

export interface SubmitOptions {
  env: EnvConfig
  payload: SubmitPayload
  /** body 形态：raw = 裸密文字符串（页面 axios 行为）；json = 密文外加引号 */
  bodyMode: 'raw' | 'json'
  timeout: number
  dryRun: boolean
  title: string
}

/**
 * 真实提交答题（复刻页面 service.post(url, encryptedData) 及响应拦截器的处理）
 * 返回 null 表示 dryRun 未发送
 */
export async function submitExam(options: SubmitOptions): Promise<SubmitResponseResult | null> {
  const { env, payload, bodyMode, timeout, dryRun, title } = options
  const url = `${env.VITE_API_URL ?? ''}${SUBMIT_PATH}`
  // 页面：service.post(url, encryptedData)，data 是字符串，axios 不会 JSON.stringify，body 即裸密文
  const body = bodyMode === 'json' ? JSON.stringify(payload.cipherWithPrefix) : payload.cipherWithPrefix
  const privateKey = env.VITE_SM_PRIVATE_KEY ?? ''

  console.log(heading(title))
  console.log(`${label('POST')}      ${url}`)
  console.log(`${label('Content-Type')} : application/json`)
  console.log(`${label('body 形态')} : ${bodyMode === 'raw' ? '裸 hex 密文字符串（与页面 axios 行为一致）' : 'JSON 字符串（密文外加引号）'}`)
  console.log(`${label('body 长度')} : ${Buffer.byteLength(body)} 字节`)
  console.log(`${label('密文格式')}  : C1 带 04 前缀（与页面 SmCryptoV2 一致）`)
  console.log(`${label('请求超时')}  : ${timeout}ms`)

  if (dryRun) {
    console.log(warn('--dry-run：只构建请求体，未发送'))
    return null
  }

  const startedAt = Date.now()
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...SUBMIT_HEADERS, 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  })
  const rawBody = await response.text()
  const elapsedMs = Date.now() - startedAt

  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    headers[name] = value
  })

  const json = parseJsonTolerant(rawBody)
  const jsonObject = json && typeof json === 'object' ? (json as Record<string, unknown>) : null

  const code = jsonObject && typeof jsonObject.code === 'number' ? jsonObject.code : null
  const messageRaw = jsonObject && typeof jsonObject.message === 'string' ? jsonObject.message : null
  const message = messageRaw ? (privateKey ? decodeTolerant(decryptTolerant(messageRaw, privateKey)) : messageRaw) : null
  const errors = jsonObject ? (jsonObject.errors ?? null) : null

  let resultText: string | null = null
  let result: Record<string, unknown> | null = null
  const resultRaw = jsonObject ? jsonObject.result : undefined
  if (typeof resultRaw === 'string' && resultRaw.length > 0) {
    resultText = privateKey ? decryptTolerant(resultRaw, privateKey) : resultRaw
    const parsed = parseJsonTolerant(resultText)
    if (parsed && typeof parsed === 'object') {
      result = parsed as Record<string, unknown>
      resultText = JSON.stringify(result)
    }
  } else if (resultRaw && typeof resultRaw === 'object') {
    result = resultRaw as Record<string, unknown>
    resultText = JSON.stringify(result)
  }

  return {
    url,
    bodyMode,
    requestBytes: Buffer.byteLength(body),
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    elapsedMs,
    headers,
    rawBody,
    code,
    message,
    errors,
    resultText,
    result,
    alreadySubmitted: result?.status === 'already_submitted',
    isPassed: typeof result?.isPassed === 'boolean' ? result.isPassed : null,
  }
}

/** 打印提交结果（原始响应 + 业务字段 + 判定） */
export function printSubmitResponse(result: SubmitResponseResult): void {
  const statusLine = `HTTP ${result.status} ${result.statusText}   ${result.elapsedMs}ms`
  console.log(`\n${result.ok ? ok(statusLine) : fail(statusLine)}`)
  console.log(`\n${subheading('响应头：')}`)
  for (const [name, value] of Object.entries(result.headers)) {
    console.log(`  ${label(name)}: ${value}`)
  }

  console.log(`\n${subheading('原始响应体：')}`)
  console.log(result.rawBody)

  console.log(`\n${subheading('业务字段（按页面拦截器逻辑处理）：')}`)
  console.log(`  ${label('code')}    : ${result.code ?? '(无 code，按非规范化响应原样返回)'}`)
  console.log(`  ${label('message')} : ${result.message ?? '-'}`)
  if (result.errors) console.log(`  ${label('errors')}  : ${JSON.stringify(result.errors)}`)
  if (result.resultText) console.log(`  ${label('result')}  : ${result.resultText}`)

  console.log(`\n${subheading('判定：')}`)
  if (result.errors) {
    console.log(`  ${fail(`接口返回 errors，提交失败：${JSON.stringify(result.errors)}`)}`)
  } else if (result.code != null && result.code !== 200) {
    console.log(`  ${fail(`业务失败（code=${result.code}）：${result.message ?? ''}`)}`)
  } else if (result.alreadySubmitted) {
    console.log(`  ${warn('已参与过该考试（result.status = already_submitted）')}`)
    if (result.isPassed != null) console.log(`  ${label('历史结果 isPassed')} = ${result.isPassed ? ok('true') : fail('false')}`)
  } else if (result.ok) {
    console.log(`  ${ok('提交成功')}`)
    if (result.isPassed != null) console.log(`  ${label('isPassed')} = ${result.isPassed ? ok('true') : fail('false')}`)
  } else {
    console.log(`  ${fail(`请求失败（HTTP ${result.status}）`)}`)
  }
}
