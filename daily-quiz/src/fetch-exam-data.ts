/**
 * 主流程脚本：调用考试数据接口 → 按答题范围筛选 → 渲染题目详情 → 构建并真实提交
 *
 * 模块划分：
 *   upstream.ts        上游接口常量与请求（指针文件 / 数据文件）
 *   exam-types.ts      试卷与题目的公共类型
 *   exam-utils.ts      纯函数工具（题型名、字母、HTML 转文本、options 解析、日期、JSON 容错）
 *   submit-payload.ts  配置读取、工号解析、提交体构建与提交、相关打印
 *   terminal-style.ts  终端加粗/颜色
 *
 * 流程（与列表页 + 题目详情页一致）：
 *   1) GET /exam-data/exam_data_latest.json                  -> { "current": "exam_data_xxx.json" }
 *   2) GET /exam-data/<current>?t=<5 分钟粒度版本号>          -> 全部试卷数组
 *      按 questions[0].factory === 厂区 过滤（保持接口顺序），打印列表前 N 条
 *   3) 按「答题范围」筛出要处理的试卷，逐份按题目详情页（题目详情.html）的规则渲染详情：
 *      标题 = questions[0].questionName || examinationName，以及题干、选项、正确答案、解析
 *      范围来自 config.js：
 *        QUIZ_SCOPE = "public"（默认，只答公共题）/ "custom"（只答 QUIZ_CATEGORIES）/ "all"（当天该厂区全部）
 *        QUIZ_ONLY_TODAY 控制是否只处理 startTime 为当天的试卷（默认 true）
 *      （第三步不再发请求，数据在上一步已经拿到）
 *   4) 每份试卷 × 每个工号各构建一份提交请求体：
 *      明文 { ExaminationId, Code, Answers } -> encodeURIComponent -> SM2 加密，
 *      打印明文 / 两种密文格式 / 两种 body 形态 / 本地解密自检
 *      工号取 config.js 的 QUIZ_JOB_NUMBERS（支持数组），
 *      也可用 --code / 环境变量 QUIZ_CODE 临时覆盖；都没有才提示终端交互输入
 *   5) 按页面逻辑真实提交：POST /api/StudentExam/SubmitByHtml，body 就是密文；
 *      响应按页面拦截器处理：解密 message / result，识别 already_submitted、isPassed 等
 *      多份试卷/多个工号时串行逐个提交，最后打印成功/失败汇总
 *
 * 用法：
 *   pnpm start                                       默认 TJ2 厂区 + QUIZ_SCOPE 配置的范围，构建并真实提交
 *   pnpm start -- --code ALS8594                     指定工号（跳过 config 与交互）
 *   pnpm start -- --dry-run                          只构建提交体，不真实发送
 *   pnpm start -- --body-mode json                   body 用「密文外加引号」形态（默认 raw 裸密文）
 *   pnpm start -- --submit-timeout 30000             提交接口超时（默认 15000；页面 axios 是 3000）
 *   pnpm start -- --skip-payload                     只做前三步，不构建提交请求体
 *   pnpm start -- --submit-exam-id 849774176309317   只处理这一份试卷（优先级高于范围配置）
 *   pnpm start -- --limit 5                          打印前 5 条
 *   pnpm start -- --factory TJ4北厂                  临时换厂区（覆盖 config.js 的 QUIZ_FACTORY）
 *   pnpm start -- --detail-category 制剂生产          临时把范围缩到该类别（覆盖 QUIZ_SCOPE）
 *   pnpm start -- --full                             额外打印数据文件的原始响应体（默认省略）
 *   pnpm start -- --raw                              响应体原样打印（不做 JSON 美化）
 *   pnpm start -- --out data.json                    把数据文件响应体保存到文件
 *   pnpm start -- --json                             以 JSON 输出结构化结果（含前 N 条与提交体）
 *   pnpm start -- --t 5965710                        指定 t 参数（复现抓包时的 URL）
 *   pnpm start -- --no-t                             不附加 t 参数
 *   pnpm start -- --config ./config.js               指定 config.js 路径（默认根目录 config.js）
 *   pnpm start -- <文件或完整 URL>                    跳过指针文件，直接调用该接口并打印原始响应
 *
 * 可用环境变量：
 *   UPSTREAM_ORIGIN   上游站点，默认 https://ehs30sfun-cdn.asymchem.com.cn
 *   REQUEST_TIMEOUT   单次请求超时（毫秒），默认 30000
 *   MAX_PRINT_CHARS   终端里原始响应体最大打印字符数，默认 4000
 *   SUBMIT_TIMEOUT    提交接口超时（毫秒），默认 15000
 *   QUIZ_CODE         工号（明文），等价于 --code
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  formatDate,
  htmlToText,
  isCorrectOption,
  letterAt,
  parseOptions,
  prettyBody,
  questionTypeName,
  stripHtmlOneLine,
  toPositiveInt,
  todayString,
} from './exam-utils.js'
import type { ExamItem, QuestionItem } from './exam-types.js'
import {
  currentVersion,
  DATA_DIR,
  fetchUpstream,
  POINTER_PATH,
  resolveUpstreamUrl,
  type UpstreamResponse,
} from './upstream.js'
import { fail, heading, label, ok, subheading, warn } from './terminal-style.js'
import {
  buildSubmitPayload,
  loadEnvConfig,
  printConfig,
  printSubmitPayload,
  printSubmitResponse,
  resolveJobNumbers,
  resolveScopeConfig,
  submitExam,
  type EnvConfig,
  type JobTarget,
  type ScopeConfig,
  type SubmitPayload,
} from './submit-payload.js'

/** 默认打印条数 */
const DEFAULT_LIMIT = 3
/** 默认配置文件路径（根目录 config.js，内容与页面 /config.js 同源） */
const DEFAULT_CONFIG_PATH = join(process.cwd(), 'config.js')
/** 提交接口超时（页面 axios 用的是 3000ms，这里默认放宽以免网络抖动被误判为失败） */
const DEFAULT_SUBMIT_TIMEOUT = toPositiveInt(process.env.SUBMIT_TIMEOUT, 15_000)
/** 终端里原始响应体的最大打印字符数 */
const MAX_PRINT_CHARS = toPositiveInt(process.env.MAX_PRINT_CHARS, 4000)

/* ---------------------------------- 类型 ---------------------------------- */

/** 按列表页展示口径整理出来的列表行 */
interface ListItem {
  id: string
  displayName: string
  examinationName: string
  factory: string
  category: string
  date: string
  startTime: string
  endTime: string
  question: {
    id: string
    type: string
    points: number | null
    text: string
  } | null
}

interface CliOptions {
  /** 接口路径或完整 URL；指定后跳过指针文件这一步 */
  input?: string
  /** 厂区；未指定时取 config.js 的 QUIZ_FACTORY，再退回 TJ2 */
  factory?: string
  /** 打印条数，默认 3 */
  limit: number
  /** 临时覆盖答题范围：只处理该类别（优先级高于 config.js 的 QUIZ_SCOPE） */
  detailCategory?: string
  /** 手动指定 t 参数 */
  t?: string
  /** 不附加 t 参数 */
  noT: boolean
  /** 响应体完整打印 */
  full: boolean
  /** 响应体原样打印 */
  raw: boolean
  /** 以 JSON 输出结构化结果 */
  json: boolean
  /** 把数据文件响应体保存到该文件 */
  out?: string
  /** 跳过第四、五步（不构建提交请求体、不提交） */
  skipPayload: boolean
  /** 第四步针对的试卷 id，默认用第三步那份 */
  submitExamId?: string
  /** config.js 路径 */
  configPath: string
  /** 直接指定工号（明文） */
  code?: string
  /** 直接指定已编码的 Code */
  codeBase64?: string
  /** 只构建提交体、不真实发送（默认会调用提交接口） */
  dryRun: boolean
  /** 提交 body 形态：raw = 裸密文字符串（页面 axios 行为），json = 密文外加引号 */
  bodyMode: 'raw' | 'json'
  /** 提交接口超时（毫秒） */
  submitTimeout: number
}

/* ---------------------------------- 参数 ---------------------------------- */

/** 布尔开关：出现即为 true */
const BOOLEAN_FLAGS: Record<string, keyof CliOptions> = {
  '--raw': 'raw',
  '--json': 'json',
  '--full': 'full',
  '--no-t': 'noT',
  '--skip-payload': 'skipPayload',
  '--dry-run': 'dryRun',
}

/** 取值参数：flag -> 赋值（缺值时保持原值，与旧实现一致） */
function valueHandlers(options: CliOptions): Record<string, (value: string) => void> {
  return {
    '--factory': (value) => {
      options.factory = value
    },
    '--limit': (value) => {
      options.limit = toPositiveInt(value, options.limit)
    },
    '--detail-category': (value) => {
      options.detailCategory = value
    },
    '--submit-exam-id': (value) => {
      options.submitExamId = value
    },
    '--body-mode': (value) => {
      options.bodyMode = value === 'json' ? 'json' : 'raw'
    },
    '--submit-timeout': (value) => {
      options.submitTimeout = toPositiveInt(value, options.submitTimeout)
    },
    '--config': (value) => {
      options.configPath = value
    },
    '--code': (value) => {
      options.code = value
    },
    '--code-base64': (value) => {
      options.codeBase64 = value
    },
    '--t': (value) => {
      options.t = value
    },
    '--out': (value) => {
      options.out = value
    },
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    limit: DEFAULT_LIMIT,
    configPath: DEFAULT_CONFIG_PATH,
    noT: false,
    full: false,
    raw: false,
    json: false,
    skipPayload: false,
    dryRun: false,
    bodyMode: 'raw',
    submitTimeout: DEFAULT_SUBMIT_TIMEOUT,
  }
  const handlers = valueHandlers(options)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg in BOOLEAN_FLAGS) {
      const key = BOOLEAN_FLAGS[arg] as 'raw' | 'json' | 'full' | 'noT' | 'skipPayload' | 'dryRun'
      options[key] = true
    } else if (arg in handlers) {
      const value = args[i + 1]
      if (value !== undefined) {
        i++
        ;(handlers[arg] as (text: string) => void)(value)
      }
    } else if (!arg.startsWith('--')) {
      options.input = arg
    }
  }
  return options
}

/* ---------------------------------- 工具 ---------------------------------- */

/** 从指针文件响应里取出 current（真实数据文件名） */
function readCurrent(pointerBody: string): string {
  let meta: { current?: unknown }
  try {
    meta = JSON.parse(pointerBody) as { current?: unknown }
  } catch {
    throw new Error(`指针文件不是合法 JSON：${pointerBody.slice(0, 120)}`)
  }
  if (typeof meta.current !== 'string' || meta.current.length === 0) {
    throw new Error(`指针文件里没有 current 字段：${pointerBody.slice(0, 120)}`)
  }
  return meta.current
}

/** 解析数据文件响应体，必须是数组 */
function parseExamData(body: string): ExamItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`数据文件不是合法 JSON：${body.slice(0, 120)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('数据文件不是数组结构，无法按列表页规则筛选')
  }
  return parsed as ExamItem[]
}

/* ------------------------------ 列表页取值逻辑 ------------------------------ */

/**
 * 复刻 iiii.html 的过滤逻辑：
 * 按「第一条题目的 factory」匹配厂区，filter 保持接口返回顺序
 */
function filterByFactory(data: ExamItem[], factory: string): ExamItem[] {
  return data.filter((exam) => {
    const first = exam.questions?.[0]
    return Boolean(first) && first?.factory === factory
  })
}

/**
 * 按配置的答题范围筛选要处理的试卷（保持接口返回顺序）：
 *   categories 为空数组表示不按类别过滤（QUIZ_SCOPE = all）
 *   onlyToday 为 true 时只保留 startTime 是当天的试卷
 */
function selectScopeExams(exams: ExamItem[], scope: ScopeConfig): ExamItem[] {
  const today = todayString()
  return exams.filter((exam) => {
    const question = exam.questions?.[0]
    if (!question) return false
    if (scope.categories.length > 0 && !scope.categories.includes(String(question.category ?? ''))) return false
    if (scope.onlyToday && formatDate(exam.startTime) !== today) return false
    return true
  })
}

/** 按列表页展示口径整理单条数据（显示名、厂区、类别、日期都来自 questions[0]） */
function toListItem(exam: ExamItem): ListItem {
  const question = exam.questions?.[0]
  return {
    id: String(exam.id ?? ''),
    displayName: question?.questionName || exam.examinationName || '(无名称)',
    examinationName: exam.examinationName ?? '-',
    factory: question?.factory ?? '-',
    category: question?.category ?? '-',
    date: formatDate(exam.startTime),
    startTime: exam.startTime ?? '-',
    endTime: exam.endTime ?? '-',
    question: question
      ? {
          id: String(question.id ?? ''),
          type: question.questionType != null ? questionTypeName(question.questionType) : '未知题型',
          points: question.points ?? null,
          text: stripHtmlOneLine(question.questionText, 100),
        }
      : null,
  }
}

/* ---------------------------------- 打印 ---------------------------------- */

function printResponseHead(result: UpstreamResponse, title: string): void {
  console.log(heading(title))
  console.log(`${label('请求')}  ${result.method} ${result.url}`)
  const statusLine = `HTTP ${result.status} ${result.statusText}  ${result.elapsedMs}ms  ${result.bytes} 字节`
  console.log(`${label('响应')}  ${result.ok ? ok(statusLine) : warn(statusLine)}`)
  console.log(`\n${subheading('响应头：')}`)
  for (const [name, value] of Object.entries(result.headers)) {
    console.log(`  ${label(name)}: ${value}`)
  }
}

function printBody(body: string, options: CliOptions): void {
  const text = options.raw ? body : prettyBody(body)
  console.log(`\n${subheading('响应体：')}`)
  if (options.full || text.length <= MAX_PRINT_CHARS) {
    console.log(text)
    return
  }
  console.log(text.slice(0, MAX_PRINT_CHARS))
  console.log(`\n${warn(`...（共 ${body.length} 字符，已截断；用 --full 完整打印，或用 --out <文件> 保存）`)}`)
}

/** 打印厂区列表前 N 条 */
function printExamList(items: ListItem[], options: CliOptions, factory: string, total: number, matched: number): void {
  console.log(heading(`${factory} 厂区 · 每日列表前 ${options.limit} 条`))
  console.log(`${label('过滤条件')} : questions[0].factory === "${factory}"；接口共 ${total} 条，匹配 ${matched} 条（顺序与列表页一致）`)

  if (items.length === 0) {
    console.log(warn(`没有找到 ${factory} 厂区的数据`))
    return
  }

  items.slice(0, options.limit).forEach((item, index) => {
    console.log(`\n${subheading(`[${index + 1}] id = ${item.id}`)}`)
    console.log(`    ${label('列表显示名')} : ${item.displayName}`)
    console.log(`    ${label('试卷名称')}   : ${item.examinationName}`)
    console.log(`    ${label('厂区 / 类别')}: ${item.factory} / ${item.category}`)
    console.log(`    ${label('日期')}       : ${item.date}`)
    console.log(`    ${label('有效期')}     : ${item.startTime} ~ ${item.endTime}`)
    if (item.question) {
      console.log(`    ${label('题目')}       : [${item.question.type}] id=${item.question.id} 分值=${item.question.points ?? '-'}`)
      console.log(`    ${label('题干')}       : ${item.question.text}`)
    }
    console.log(`    ${label('答题参数')}   : start-exam.html?examId=${item.id}`)
  })

  console.log(`\n${subheading(`（${factory} 共 ${matched} 条，已显示前 ${Math.min(options.limit, matched)} 条）`)}`)
}

/** 渲染单道题目（对应题目详情页里每道题的展示样式） */
function printQuestion(question: QuestionItem, index: number): void {
  console.log(`\n  ${subheading(`── 第 ${index + 1} 题 ──────────────────────────────`)}`)
  console.log(
    `  [${String(index + 1).padStart(2, '0')}] ${questionTypeName(question.questionType)}   分值 ${question.points ?? '-'}   题目 id ${question.id ?? '-'}`,
  )
  console.log(`  ${label('题干：')}`)
  console.log(`  ${htmlToText(question.questionText)}`)

  if (question.questionType === 1 || question.questionType === 2) {
    const optionTexts = parseOptions(question.options)
    if (optionTexts.length === 0) {
      console.log(`  ${warn('选项：无')}`)
    } else {
      console.log(`  ${label('选项（页面上单选/多选会随机打乱顺序，这里按接口原始顺序展示）：')}`)
      optionTexts.forEach((text, optionIndex) => {
        const letter = letterAt(optionIndex)
        console.log(`    ${letter}. ${text}${isCorrectOption(question, letter) ? `   ${ok('← 正确答案')}` : ''}`)
      })
    }
    console.log(`  ${label('正确答案：')}${question.correctAnswer ?? '-'}${question.questionType === 2 ? '（多选，字母已排序）' : ''}`)
  } else if (question.questionType === 3) {
    console.log(`  ${label('选项：')}`)
    console.log(`    A. 正确 (Correct)${question.correctAnswer === '对' ? `   ${ok('← 正确答案')}` : ''}`)
    console.log(`    B. 错误 (Incorrect)${question.correctAnswer === '错' ? `   ${ok('← 正确答案')}` : ''}`)
    console.log(`  ${label('正确答案：')}${question.correctAnswer === '对' ? 'A' : 'B'}（数据里存的是“${question.correctAnswer ?? '-'}”，提交时也按这个值发）`)
  } else {
    console.log(`  ${label('正确答案：')}${question.correctAnswer ?? '-'}`)
  }

  if (question.explanation) {
    console.log('  解析：')
    console.log(`  ${htmlToText(question.explanation)}`)
  }
}

/** 第三步：按题目详情页（题目详情.html）的规则渲染「答题范围」命中的试卷详情 */
function printExamDetail(exams: ExamItem[], scope: ScopeConfig): void {
  console.log(heading(`3/5 题目详情（${scope.factory} · 范围 ${scope.scope}，命中 ${exams.length} 份）`))
  console.log(`${label('范围来源')} : ${scope.source}`)
  console.log(`${label('类别过滤')} : ${scope.categories.length > 0 ? scope.categories.join('、') : '不按类别过滤（all）'}`)
  console.log(`${label('仅当天')}   : ${scope.onlyToday ? '是' : '否'}`)

  if (exams.length === 0) {
    console.log(warn('答题范围内没有命中任何试卷，跳过题目详情与提交'))
    return
  }

  console.log(`\n${subheading('命中试卷：')}`)
  exams.forEach((exam, index) => {
    const question = exam.questions?.[0]
    console.log(
      `  [${index + 1}] ${exam.id} | ${question?.category ?? '-'} | ${question?.questionName || exam.examinationName || '(无名称)'} | ${formatDate(exam.startTime)}`,
    )
  })

  exams.forEach((exam) => {
    const questions = exam.questions ?? []
    const firstQuestion = questions[0]
    const displayName = firstQuestion?.questionName || exam.examinationName || '(无名称)'
    console.log(`\n${subheading(`—— ${firstQuestion?.category ?? '-'}｜${displayName}（examId=${exam.id}）——`)}`)
    console.log(`${label('题目数量')}   : ${questions.length}`)
    if (questions.length === 0) {
      console.log(warn('该试卷没有题目数据'))
      return
    }
    questions.forEach((question, index) => printQuestion(question, index))
  })
}

/* ----------------------------- 第四步 / 第五步 ----------------------------- */

/** 读取 config.js；失败时提示一行并返回空配置（不中断数据流程） */
async function loadEnvConfigSafe(options: CliOptions): Promise<EnvConfig> {
  try {
    return await loadEnvConfig(options.configPath)
  } catch (error) {
    if (!options.json) {
      console.log(`\n${warn(`读取 config.js 失败，将使用默认范围与工号来源：${error instanceof Error ? error.message : String(error)}`)}`)
    }
    return {}
  }
}

/** 第四步 + 第五步：按答题范围，逐份试卷 × 逐工号构建提交体并提交 */
async function printSubmitStep(options: CliOptions, env: EnvConfig, scope: ScopeConfig, scopeExams: ExamItem[]): Promise<void> {
  if (scopeExams.length === 0) {
    console.log(heading('4/5 提交请求体（跳过）'))
    console.log(warn('答题范围内没有命中试卷，跳过提交体构建与提交'))
    return
  }

  console.log(`\n${subheading('配置（用于构建提交体，来自 config.js）：')}`)
  printConfig(env, options.configPath)

  // 工号来源：--code / QUIZ_CODE > config.js 的 QUIZ_JOB_NUMBERS（支持多个）> 终端交互兜底
  const targets = await resolveJobNumbers({
    code: options.code,
    codeBase64: options.codeBase64,
    configured: env.QUIZ_JOB_NUMBERS,
  })

  console.log(
    `\n${subheading(`待提交清单：${scopeExams.length} 份试卷 × ${targets.length} 个工号 = ${scopeExams.length * targets.length} 次提交`)}`,
  )
  console.log(`  答题范围：${scope.scope}（${scope.source}）`)
  console.log(`  试卷：${scopeExams.map((exam) => `${exam.questions?.[0]?.category ?? '-'}(id=${exam.id})`).join('、')}`)
  console.log(`  工号：${targets.map((target) => target.jobNumber ?? '(已编码)').join(', ')}`)

  const compact = scopeExams.length > 1 || targets.length > 1
  const prepared = preparePayloads(env, scopeExams, targets, compact)

  // 第五步：按源码逻辑真实提交（POST /api/StudentExam/SubmitByHtml），串行逐个提交
  const { successCount, failures } = await submitAll(options, env, prepared, compact)

  if (compact && !options.dryRun) {
    console.log(heading('提交汇总'))
    console.log(`  ${label('提交次数')} : ${prepared.length}`)
    console.log(
      `  ${label('成功数')}   : ${successCount >= prepared.length ? ok(String(successCount)) : warn(`${successCount}/${prepared.length}`)}`,
    )
    if (failures.length > 0) {
      for (const item of failures) console.log(`  ${fail(`失败：${item}`)}`)
    } else {
      console.log(`  ${ok('全部提交完成')}`)
    }
  }
}

interface PreparedItem {
  exam: ExamItem
  target: JobTarget
  payload: SubmitPayload
}

/** 第四步：每份试卷 × 每个工号各构建一份提交体（Code 与密文都不同） */
function preparePayloads(env: EnvConfig, scopeExams: ExamItem[], targets: JobTarget[], compact: boolean): PreparedItem[] {
  const prepared: PreparedItem[] = []
  for (const exam of scopeExams) {
    const examLabel = `${exam.questions?.[0]?.category ?? '-'}｜id=${exam.id}`
    for (const target of targets) {
      const payload = buildSubmitPayload(exam, target.code, env.VITE_SM_PUBLIC_KEY as string)
      printSubmitPayload({
        title: compact ? `4/5 提交请求体 · ${examLabel} · 工号 ${target.jobNumber ?? target.code}` : '4/5 提交请求体（SM2 加密）',
        exam,
        code: target.code,
        codeSource: target.codeSource,
        env,
        payload,
        compact,
      })
      prepared.push({ exam, target, payload })
    }
  }
  return prepared
}

/** 第五步：串行逐个提交，返回成功数与失败明细 */
async function submitAll(
  options: CliOptions,
  env: EnvConfig,
  prepared: PreparedItem[],
  compact: boolean,
): Promise<{ successCount: number; failures: string[] }> {
  let successCount = 0
  const failures: string[] = []

  for (const [index, { exam, target, payload }] of prepared.entries()) {
    const who = target.jobNumber ?? '(已编码)'
    const examLabel = `${exam.questions?.[0]?.category ?? '-'}｜id=${exam.id}`
    try {
      const response = await submitExam({
        env,
        payload,
        bodyMode: options.bodyMode,
        timeout: options.submitTimeout,
        dryRun: options.dryRun,
        title: compact
          ? `5/5 提交答题 · ${examLabel} · 工号 ${who}（${index + 1}/${prepared.length}）`
          : '5/5 提交答题（真实调用 /api/StudentExam/SubmitByHtml）',
      })
      if (!response) continue // --dry-run 未发送
      printSubmitResponse(response)
      if (response.code == null || response.code === 200) successCount++
      else failures.push(`${examLabel} · ${who}: code=${response.code} ${response.message ?? ''}`.trim())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`\n${fail(`${examLabel} · 工号 ${who} 提交失败：${message}`)}`)
      failures.push(`${examLabel} · ${who}: ${message}`)
    }
  }

  return { successCount, failures }
}

/* -------------------------------- JSON 输出 -------------------------------- */

/** JSON 模式：只构建提交体摘要（工号来自 --code / 环境变量 / config.js；不交互、也不真实提交） */
async function buildSubmitSummary(
  options: CliOptions,
  env: EnvConfig,
  scope: ScopeConfig,
  scopeExams: ExamItem[],
): Promise<Record<string, unknown> | null> {
  if (scopeExams.length === 0) return null

  try {
    const targets = await resolveJobNumbers({
      code: options.code,
      codeBase64: options.codeBase64,
      configured: env.QUIZ_JOB_NUMBERS,
      interactive: false,
    })
    return {
      scope: {
        mode: scope.scope,
        categories: scope.categories,
        onlyToday: scope.onlyToday,
        factory: scope.factory,
        source: scope.source,
      },
      jobNumbers: targets.map((target) => target.jobNumber),
      submitted: false,
      payloads: scopeExams.flatMap((exam) =>
        targets.map((target) => {
          const payload = buildSubmitPayload(exam, target.code, env.VITE_SM_PUBLIC_KEY as string)
          return {
            examId: String(exam.id ?? ''),
            category: exam.questions?.[0]?.category ?? null,
            code: target.code,
            codeSource: target.codeSource,
            plainJson: payload.plainJson,
            cipherWithPrefix: payload.cipherWithPrefix,
            cipherWithoutPrefix: payload.cipherWithoutPrefix,
          }
        }),
      ),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

interface JsonReportInput {
  options: CliOptions
  scope: ScopeConfig
  current: string
  pointer: UpstreamResponse
  dataResult: UpstreamResponse
  data: ExamItem[]
  matchedExams: ExamItem[]
  matchedItems: ListItem[]
  scopeExams: ExamItem[]
  submitSummary: Record<string, unknown> | null
}

/** 以 JSON 输出完整结果（供程序消费） */
function printJsonReport(input: JsonReportInput): void {
  const { options, scope, current, pointer, dataResult, data, matchedExams, matchedItems, scopeExams, submitSummary } = input
  console.log(
    JSON.stringify(
      {
        factory: scope.factory,
        limit: options.limit,
        current,
        pointer: { url: pointer.url, status: pointer.status, body: JSON.parse(pointer.body) },
        data: { url: dataResult.url, status: dataResult.status, bytes: dataResult.bytes, headers: dataResult.headers },
        total: data.length,
        matched: matchedExams.length,
        list: matchedItems.slice(0, options.limit),
        scope: {
          mode: scope.scope,
          categories: scope.categories,
          onlyToday: scope.onlyToday,
          factory: scope.factory,
          source: scope.source,
        },
        scopeExams: scopeExams.map((exam) => ({
          examId: String(exam.id ?? ''),
          category: exam.questions?.[0]?.category ?? null,
          questionCount: exam.questions?.length ?? 0,
          startTime: exam.startTime ?? null,
        })),
        submit: submitSummary,
      },
      null,
      2,
    ),
  )
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const t = options.noT ? undefined : (options.t ?? currentVersion())
  
  /**
   * options:
   *   limit: 3,
      configPath: 'D:\\testCode\\demo\\daily-quiz\\config.js',
      noT: false,
      full: false,
      raw: false,
      json: false,
      skipPayload: false,
      dryRun: true,
      bodyMode: 'raw',
   */
  // 指定了具体接口：直接调用并打印原始响应
  if (options.input) {
    const result = await fetchUpstream(options.input, t)
    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      printResponseHead(result, `调用 ${options.input}`)
      printBody(result.body, options)
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  // 第一步：指针文件
  const pointer = await fetchUpstream(POINTER_PATH)
  const current = readCurrent(pointer.body)

  if (!options.json) {
    printResponseHead(pointer, '1/5 指针文件')
    printBody(pointer.body, options)
    console.log(`\n${label('解析 current')} = ${current}`)
    console.log(`${label('继续调用')}   ${resolveUpstreamUrl(`${DATA_DIR}/${current}`, t)}`)
  }

  // 第二步：数据文件
  const dataResult = await fetchUpstream(`${DATA_DIR}/${current}`, t)
  const data = parseExamData(dataResult.body)

  const env = await loadEnvConfigSafe(options)
  const scope = resolveScopeConfig(env, { factory: options.factory, detailCategory: options.detailCategory })
  const matchedExams = filterByFactory(data, scope.factory)
  const matchedItems = matchedExams.map(toListItem)
  // 答题范围命中的试卷：--submit-exam-id 显式指定时只处理该试卷，否则按 QUIZ_SCOPE 筛选
  const scopeExams = options.submitExamId
    ? data.filter((item) => String(item.id) === options.submitExamId)
    : selectScopeExams(matchedExams, scope)

  if (options.out) {
    await writeFile(options.out, dataResult.body, 'utf8')
    console.log(`\n${ok(`数据文件响应体已保存到：${options.out}（${dataResult.bytes} 字节）`)}`)
  }

  if (options.json) {
    const submitSummary = options.skipPayload ? null : await buildSubmitSummary(options, env, scope, scopeExams)
    printJsonReport({ options, scope, current, pointer, dataResult, data, matchedExams, matchedItems, scopeExams, submitSummary })
  } else {
    printResponseHead(dataResult, '2/5 数据文件')
    if (options.full || options.raw) {
      printBody(dataResult.body, options)
    } else {
      console.log(`\n${warn(`响应体：已省略 ${dataResult.bytes} 字节（用 --full 打印完整内容，或用 --out <文件> 保存）`)}`)
    }
    printExamList(matchedItems, options, scope.factory, data.length, matchedExams.length)
    printExamDetail(scopeExams, scope)

    if (options.skipPayload) {
      console.log(`\n${warn('--skip-payload 已跳过第四、五步（提交请求体构建与提交）')}`)
    } else {
      await printSubmitStep(options, env, scope, scopeExams)
    }
  }

  if (!pointer.ok || !dataResult.ok) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error('调用接口失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
