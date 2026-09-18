/**
 * 纯函数工具：题型名、选项字母、HTML 转文本、options 解析、日期格式化、JSON 容错解析
 * 说明：这里只放无副作用的函数，便于各脚本复用
 */
import type { QuestionItem } from './exam-types.js'

/** 题型名（与列表页 / 答题页一致） */
export const QUESTION_TYPE_NAMES: Record<number, string> = {
  1: '单选题',
  2: '多选题',
  3: '判断题',
  4: '填空题',
  5: '简答题',
}

/** 题型名，未知题型返回「未知题型」 */
export function questionTypeName(type?: number | null): string {
  return type != null ? (QUESTION_TYPE_NAMES[type] ?? '未知题型') : '未知题型'
}

/** 序号转字母：0 -> A、1 -> B … */
export function letterAt(index: number): string {
  return String.fromCharCode(65 + index)
}

/** 判断某字母是否为正确答案（单选直接比对，多选按包含判断） */
export function isCorrectOption(question: QuestionItem, letter: string): boolean {
  const answer = (question.correctAnswer ?? '').toUpperCase()
  if (question.questionType === 1) return answer === letter
  if (question.questionType === 2) return answer.includes(letter)
  return false
}

/** 解析 options（数据里是 JSON 字符串数组） */
export function parseOptions(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

/** HTML -> 单行文本（标签替换为空格），用于列表行预览；传 maxLen 则截断并加省略号 */
export function stripHtmlOneLine(html?: string | null, maxLen?: number): string {
  if (!html) return '-'
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (maxLen != null && text.length > maxLen) return `${text.slice(0, maxLen)}...`
  return text
}

/** HTML -> 纯文本（结束标签转换行后再折叠空白），用于提交体与模拟里的题干 */
export function stripHtmlKeepLines(html?: string | null): string {
  if (!html) return '-'
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** HTML -> 多行文本（保留换行、把图片替换成占位说明），与详情页 v-html 的呈现对应 */
export function htmlToText(html?: string | null): string {
  if (!html) return '-'
  return html
    .replace(/<img[^>]*?src=["']?([^"'>\s]+)["']?[^>]*>/gi, '[图片] $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n  ')
}

/** 与列表页 formatDate 一致：YYYY-MM-DD */
export function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return dateStr
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地时区的今天：YYYY-MM-DD */
export function todayString(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 响应体是 JSON 就美化输出，否则原样返回 */
export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

/** 后端明文可能是原始 JSON，也可能是 URL 编码过的 JSON，两种都试；失败返回 null */
export function parseJsonTolerant(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 继续尝试 URL 解码
  }
  try {
    return JSON.parse(decodeURIComponent(text))
  } catch {
    return null
  }
}

/** message 之类可能被 URL 编码，解一下更可读 */
export function decodeTolerant(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 解析正整数参数：非法（NaN / <=0）时回退默认值 */
export function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
