/**
 * 模拟答题：复刻「列表页（问答列表.html）+ 题目详情页（题目详情.html）」的取值与判定规则，
 * 对指定试卷做一次「按内容选正确答案」的模拟，并把页面渲染、内部取值、提交载荷、判定结果打印出来。
 *
 * 重点验证：
 *   1) 选项被随机打乱后，页面上显示的字母（位置字母）与内部取值（原始字母）不是一回事
 *   2) 按「内容」选对时，判定一定为 true（判定用的是原始字母坐标系）
 *   3) 若误按「页面显示字母」提交，则只有在随机后恰好同位时才判对
 *
 * 用法：
 *   pnpm run simulate                               默认 TJ2 厂区列表第 2 条
 *   pnpm run simulate -- --index 1                  列表第 1 条
 *   pnpm run simulate -- --exam-id 849774176309317  直接指定 examId
 *   pnpm run simulate -- --rounds 3                 模拟 3 轮随机（默认 3）
 *   pnpm run simulate -- --factory TJ2              指定厂区（默认 TJ2）
 *
 * 可用环境变量：
 *   UPSTREAM_ORIGIN   上游站点，默认 https://ehs30sfun-cdn.asymchem.com.cn
 *   REQUEST_TIMEOUT   单次请求超时（毫秒），默认 30000
 */
import { letterAt, parseOptions, questionTypeName, stripHtmlKeepLines } from './exam-utils.js'
import type { ExamItem, QuestionItem } from './exam-types.js'
import { DEFAULT_FACTORY } from './submit-payload.js'
import { loadExamData } from './upstream.js'

const DEFAULT_INDEX = 2
const DEFAULT_ROUNDS = 3

interface CliOptions {
  factory: string
  index: number
  examId?: string
  rounds: number
}

/* ---------------------------------- 工具 ---------------------------------- */

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { factory: DEFAULT_FACTORY, index: DEFAULT_INDEX, rounds: DEFAULT_ROUNDS }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--factory') options.factory = args[++i] ?? options.factory
    else if (arg === '--index') options.index = Number(args[++i] ?? options.index)
    else if (arg === '--exam-id') options.examId = args[++i]
    else if (arg === '--rounds') options.rounds = Number(args[++i] ?? options.rounds)
  }
  return options
}

/** 与页面一致的 Fisher-Yates 洗牌 */
function shuffle<T>(array: T[]): T[] {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j] as T, result[i] as T]
  }
  return result
}

/** 复刻详情页 calculateResults 的判定规则 */
function judge(question: QuestionItem, studentAnswer: string | string[] | null): { isCorrect: boolean; detail: string } {
  if (question.questionType === 1 || question.questionType === 3) {
    const answer = Array.isArray(studentAnswer) ? studentAnswer[0] : studentAnswer
    return {
      isCorrect: answer === question.correctAnswer,
      detail: `studentAnswer=${JSON.stringify(answer)} === correctAnswer=${JSON.stringify(question.correctAnswer)}`,
    }
  }
  if (question.questionType === 2) {
    const picked = Array.isArray(studentAnswer) ? studentAnswer : []
    const sortedPicked = [...picked].sort().join('')
    const sortedCorrect = String(question.correctAnswer ?? '').split('').sort().join('')
    return {
      isCorrect: picked.length > 0 && sortedPicked === sortedCorrect,
      detail: `sort(studentAnswer)=${JSON.stringify(sortedPicked)} === sort(correctAnswer)=${JSON.stringify(sortedCorrect)}`,
    }
  }
  const answer = Array.isArray(studentAnswer) ? studentAnswer.join('') : (studentAnswer ?? '')
  return {
    isCorrect: answer.trim() === String(question.correctAnswer ?? '').trim(),
    detail: '文本 trim 后比较',
  }
}

/* -------------------------------- 接口调用 -------------------------------- */

/** 两步拉取：指针文件 -> 数据文件（共用 upstream 模块，超时与请求头都在那里配置） */
async function fetchExamList(): Promise<ExamItem[]> {
  const loaded = await loadExamData<ExamItem>()
  console.log(`指针文件 current = ${loaded.current}   数据文件 t = ${loaded.t}`)
  return loaded.data
}

/* --------------------------------- 模拟逻辑 -------------------------------- */

/** 单题模拟：打印页面渲染、我的作答、提交载荷与判定结果 */
function simulateQuestion(question: QuestionItem, questionIndex: number): void {
  const typeName = questionTypeName(question.questionType)
  console.log(`\n  ── 第 ${questionIndex + 1} 题 ──────────────────────────────`)
  console.log(`  [${String(questionIndex + 1).padStart(2, '0')}] ${typeName}   分值 ${question.points ?? '-'}   题目 id ${question.id ?? '-'}`)
  console.log(`  题干：${stripHtmlKeepLines(question.questionText)}`)

  // 判断题：页面固定两行，不参与随机
  if (question.questionType === 3) {
    console.log('  页面渲染（判断题不随机）：')
    console.log(`    显示 A. 正确 (Correct)   [内部值 对]${question.correctAnswer === '对' ? '   ← 正确答案' : ''}`)
    console.log(`    显示 B. 错误 (Incorrect) [内部值 错]${question.correctAnswer === '错' ? '   ← 正确答案' : ''}`)
    const pick = question.correctAnswer === '对' ? '对' : '错'
    const result = judge(question, pick)
    console.log(`  我的作答：点击「${question.correctAnswer}」→ studentAnswer=${JSON.stringify(pick)}`)
    console.log(`  提交载荷：{ QuestionId: ${question.id}, AnswerContent: "${pick}" }`)
    console.log(`  判定：isCorrect = ${result.isCorrect} → ${result.isCorrect ? 'Pass ✓' : 'Fail ✗'}    （${result.detail}）`)
    return
  }

  // 单选 / 多选：页面会随机打乱选项顺序
  const optionTexts = parseOptions(question.options)
  if (optionTexts.length === 0) {
    console.log('  该题没有选项数据')
    return
  }

  const orders = shuffle(Array.from({ length: optionTexts.length }, (_, i) => i))
  const correctAnswer = String(question.correctAnswer ?? '')
  const correctIndexes = correctAnswer.split('').map((letter) => letter.charCodeAt(0) - 65)

  console.log(`  页面渲染（randomOptionOrders = [${orders.join(',')}]）：`)
  orders.forEach((randomIndex, displayIndex) => {
    const displayLetter = letterAt(displayIndex)
    const innerLetter = letterAt(randomIndex)
    const isCorrectContent = question.questionType === 2 ? correctAnswer.includes(innerLetter) : innerLetter === correctAnswer
    console.log(
      `    显示 ${displayLetter}. ${optionTexts[randomIndex]}   [内部值 ${innerLetter}]${isCorrectContent ? '   ← 正确答案（按内容）' : ''}`,
    )
  })

  // 我的作答：按内容选中所有正确项，点击顺序 = 页面从上到下
  const pickedDisplayIndexes = orders
    .map((randomIndex, displayIndex) => ({ randomIndex, displayIndex }))
    .filter(({ randomIndex }) => correctIndexes.includes(randomIndex))
  const innerValues = pickedDisplayIndexes.map(({ randomIndex }) => letterAt(randomIndex))
  const studentAnswer: string | string[] = question.questionType === 2 ? innerValues : innerValues[0]
  const displayLetters = pickedDisplayIndexes.map(({ displayIndex }) => letterAt(displayIndex))

  console.log('  我的作答（按内容选正确项，点击顺序 = 页面从上到下）：')
  pickedDisplayIndexes.forEach(({ displayIndex }, order) => {
    console.log(`    第 ${order + 1} 次点击：页面第 ${displayIndex + 1} 行（显示字母 ${displayLetters[order]}）`)
  })
  console.log(`    studentAnswer（内部值） = ${JSON.stringify(studentAnswer)}`)

  const answerContent = Array.isArray(studentAnswer) ? studentAnswer.join('') : studentAnswer
  console.log(
    `  提交载荷：{ ExaminationId: <当前试卷>, Code: "<工号base64>", Answers: [{ QuestionId: ${question.id}, AnswerContent: "${answerContent}" }] }`,
  )

  const result = judge(question, studentAnswer)
  console.log(`  判定：isCorrect = ${result.isCorrect} → ${result.isCorrect ? 'Pass ✓' : 'Fail ✗'}    （${result.detail}）`)

  // 正确项在页面上的显示字母（答错时页面回显的就是它）
  if (question.questionType === 1) {
    const correctDisplayIndex = orders.indexOf(correctIndexes[0] as number)
    console.log(`  页面回显（答错时会显示）：正确答案字母 = ${letterAt(correctDisplayIndex)}（即内容正确那一行所在位置）`)
  }

  // 反例：误按「页面显示字母」提交
  const byDisplayLetter: string | string[] = question.questionType === 2 ? displayLetters : (displayLetters[0] as string)
  const wrongResult = judge(question, byDisplayLetter)
  console.log(
    `  反例：若误按「页面显示字母」提交 AnswerContent = ${JSON.stringify(
      Array.isArray(byDisplayLetter) ? byDisplayLetter.join('') : byDisplayLetter,
    )} → isCorrect = ${wrongResult.isCorrect} ${wrongResult.isCorrect ? '（随机后恰好同位，偶然正确）' : '→ Fail ✗'}`,
  )
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const data = await fetchExamList()

  // 定位试卷：优先 --exam-id，否则按厂区过滤后取第 index 条
  let exam: ExamItem | undefined
  let position = ''
  if (options.examId) {
    exam = data.find((item) => String(item.id) === options.examId)
    position = `指定 examId=${options.examId}`
  } else {
    const matched = data.filter((item) => {
      const first = item.questions?.[0]
      return Boolean(first) && first?.factory === options.factory
    })
    exam = matched[options.index - 1]
    position = `${options.factory} 厂区列表第 ${options.index} 条（共 ${matched.length} 条）`
  }

  if (!exam) {
    console.error('没有定位到试卷')
    process.exitCode = 1
    return
  }

  const questions = exam.questions ?? []
  const first = questions[0]
  console.log('================ 模拟答题 ================')
  console.log(`试卷名称 : ${first?.questionName || exam.examinationName || '(无名称)'}`)
  console.log(`试卷 id  : ${exam.id}    （${position}）`)
  console.log(`厂区 / 类别: ${first?.factory ?? '-'} / ${first?.category ?? '-'}`)
  console.log(`题目数量 : ${questions.length}`)
  console.log(`模拟轮数 : ${options.rounds}    （选项随机顺序每轮都不同）`)

  if (questions.length === 0) {
    console.log('该试卷没有题目数据')
    return
  }

  for (let round = 1; round <= options.rounds; round++) {
    console.log(`\n================ 第 ${round} 轮模拟 ================`)
    questions.forEach((question, questionIndex) => simulateQuestion(question, questionIndex))
  }
}

main().catch((error: unknown) => {
  console.error('模拟失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
