/**
 * 独立入口：为指定试卷构建「提交请求体」（SM2 加密，不发任何请求）
 *
 * 主体逻辑在 ./submit-payload.ts，与 fetch-exam-data.ts 的第四步共用。
 *
 * 用法：
 *   pnpm run payload                                      默认试卷 849774175449157
 *   pnpm run payload -- --exam-id 849774176309317         指定其它试卷
 *   pnpm run payload -- --code ALS8594                    临时指定工号（优先级最高）
 *   pnpm run payload -- --code-base64 QUxTODU5NA==        直接给已编码的 Code
 *   pnpm run payload -- --config ./config.js              指定 config.js 路径
 *
 * 工号来源优先级：--code-base64 > --code / 环境变量 QUIZ_CODE
 *                > config.js 的 QUIZ_JOB_NUMBERS（支持多个，逐个构建）
 *                > 终端交互输入（仅以上都没有时才提示）
 */
import { join } from 'node:path'
import { heading } from './terminal-style.js'
import {
  buildSubmitPayload,
  loadEnvConfig,
  printConfig,
  printSubmitPayload,
  resolveJobNumbers,
  type SubmitExam,
} from './submit-payload.js'
import { loadExamData } from './upstream.js'

/** 默认构建的试卷：TJ2 列表第 1 条（公共题） */
const DEFAULT_EXAM_ID = '849774175449157'

interface CliOptions {
  examId: string
  code?: string
  codeBase64?: string
  configPath: string
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { examId: DEFAULT_EXAM_ID, configPath: join(process.cwd(), 'config.js') }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--exam-id') options.examId = args[++i] ?? options.examId
    else if (arg === '--code') options.code = args[++i]
    else if (arg === '--code-base64') options.codeBase64 = args[++i]
    else if (arg === '--config') options.configPath = args[++i] ?? options.configPath
  }
  return options
}

/** 两步拉取：指针文件 -> 数据文件（共用 upstream 模块；只读取数据，不提交任何内容） */
async function fetchExamList(): Promise<SubmitExam[]> {
  const loaded = await loadExamData<SubmitExam>()
  console.log(`数据来源：${loaded.dataUrl}`)
  return loaded.data
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  console.log(heading('1. 配置（来自 config.js）'))
  const env = await loadEnvConfig(options.configPath)
  printConfig(env, options.configPath)

  console.log(heading('2. 工号'))
  const targets = await resolveJobNumbers({
    code: options.code,
    codeBase64: options.codeBase64,
    configured: env.QUIZ_JOB_NUMBERS,
  })
  const multiple = targets.length > 1
  console.log(`待构建提交体的工号（${targets.length} 个）：${targets.map((target) => target.jobNumber ?? '(已编码)').join(', ')}`)

  const data = await fetchExamList()
  const exam = data.find((item) => String(item.id) === options.examId)
  if (!exam) throw new Error(`没有找到 examId=${options.examId} 的试卷`)

  for (const target of targets) {
    const payload = buildSubmitPayload(exam, target.code, env.VITE_SM_PUBLIC_KEY as string)
    printSubmitPayload({
      title: multiple ? `3. 提交请求体 · 工号 ${target.jobNumber ?? target.code}` : '3. 提交请求体（SM2 加密，未发送）',
      exam,
      code: target.code,
      codeSource: target.codeSource,
      env,
      payload,
      compact: multiple,
    })
  }
}

main().catch((error: unknown) => {
  console.error('构建失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
