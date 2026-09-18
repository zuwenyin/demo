/**
 * 临时分析脚本：验证题目详情.html 的选择题随机选项顺序
 * 是否会导致「页面显示的字母 / 实际提交的答案 / 判定结果 / 答案回显」出现错位
 */
const UPSTREAM = 'https://ehs30sfun-cdn.asymchem.com.cn'
const DATA_DIR = '/exam-data'

/** 与页面一致的 Fisher-Yates 洗牌 */
function shuffle<T>(array: T[]): T[] {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j] as T, result[i] as T]
  }
  return result
}

async function main(): Promise<void> {
  const pointer = (await (await fetch(`${UPSTREAM}${DATA_DIR}/exam_data_latest.json`)).json()) as { current: string }
  const data = (await (
    await fetch(`${UPSTREAM}${DATA_DIR}/${pointer.current}?t=${Math.floor(Date.now() / 300000)}`)
  ).json()) as Array<{ id: number; examinationName: string; questions: Array<Record<string, unknown>> }>

  const exam = data.find((item) => (item.questions?.[0] as { questionType?: number } | undefined)?.questionType === 1)
  if (!exam) {
    console.log('没有找到单选题')
    return
  }
  const question = exam.questions[0] as { id: number; questionText: string; options: string; correctAnswer: string }
  const options = JSON.parse(question.options) as string[]

  console.log(`试卷：${exam.examinationName}  examId=${exam.id}`)
  console.log(`题目：id=${question.id}  correctAnswer="${question.correctAnswer}"`)
  console.log('\n接口原始顺序（脚本打印的就是这个）：')
  options.forEach((text, index) => {
    const letter = String.fromCharCode(65 + index)
    console.log(`  ${letter}. ${text}${question.correctAnswer === letter ? '   ← 正确答案' : ''}`)
  })

  for (let round = 1; round <= 3; round++) {
    const orders = shuffle(Array.from({ length: options.length }, (_, i) => i))
    console.log(`\n===== 第 ${round} 次随机：randomOptionOrders = [${orders.join(',')}] =====`)
    console.log('页面渲染（displayIndex 决定显示字母，radio 的 label 用的是原始索引字母）：')
    orders.forEach((randomIndex, displayIndex) => {
      const displayLetter = String.fromCharCode(65 + displayIndex)
      const labelLetter = String.fromCharCode(65 + randomIndex)
      const isCorrect = question.correctAnswer === labelLetter
      console.log(`  显示 ${displayLetter}. ${options[randomIndex]}`)
      console.log(`        └─ radio label（=提交值）= ${labelLetter}${isCorrect ? '   ← 这就是正确项' : ''}`)
    })

    const correctDisplayIndex = orders.indexOf(question.correctAnswer.charCodeAt(0) - 65)
    const selectedLabel = String.fromCharCode(65 + (orders[correctDisplayIndex] as number))
    const displayAnswerLetter = String.fromCharCode(65 + correctDisplayIndex)
    console.log(`  用户若点中正确项（页面第 ${correctDisplayIndex + 1} 行，显示为 ${displayAnswerLetter}）：`)
    console.log(`    studentAnswer = "${selectedLabel}"   判定 isCorrect = ${selectedLabel === question.correctAnswer}`)
    console.log(`    答错时页面回显的正确答案字母 = ${displayAnswerLetter}`)
    console.log(`    提交给后端的 AnswerContent = "${selectedLabel}"`)
  }
}

void main()
