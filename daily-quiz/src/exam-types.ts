/**
 * 考试数据的公共类型（数据接口与提交接口共用一套结构）
 * 说明：字段都按「接口可能返回 null」来声明，取值时统一做兜底
 */

/** 题目 */
export interface QuestionItem {
  id?: string | number
  questionName?: string | null
  questionType?: number
  questionText?: string | null
  factory?: string | null
  category?: string | null
  points?: number
  correctAnswer?: string | null
  /** 选项：JSON 字符串数组，仅单选/多选有值 */
  options?: string | null
  /** 答案解析 */
  explanation?: string | null
}

/** 试卷（数据接口返回的数组元素） */
export interface ExamItem {
  id?: string | number
  examinationName?: string | null
  startTime?: string | null
  endTime?: string | null
  questions?: QuestionItem[] | null
}

/** 提交相关代码里的历史命名，保持对外 API 不变 */
export type SubmitQuestion = QuestionItem
export type SubmitExam = ExamItem
