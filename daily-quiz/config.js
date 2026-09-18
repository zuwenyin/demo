/**
 * 本地 config.js：结构与线上 /config.js 一致，供页面（window.__env__）与脚本读取
 * 说明：Node 脚本只做键值提取，不执行此文件里的代码
 */
window.__env__ = {
  VITE_API_URL: "https://ehs30sfun.asymchem.com.cn",
  VITE_OPEN: "true",
  VITE_OPEN_CDN: "false",
  VITE_PORT: "9000",
  VITE_PUBLIC_PATH: "",
  VITE_SM_PRIVATE_KEY: "8EDB615B1D48B8BE188FC0F18EC08A41DF50EA731FA28BF409E6552809E3A111",
  VITE_SM_PUBLIC_KEY: "0484C7466D950E120E5ECE5DD85D0C90EAA85081A3A2BD7C57AE6DC822EFCCBD66620C67B0103FC8DD280E36C3B282977B722AAEC3C56518EDCEBAFB72C5A05312",

  // 需要提交答题的工号列表：可配一个或多个，脚本会对每个工号各提交一次
  QUIZ_JOB_NUMBERS: ["ALS12556"],

  // ── 答题范围（三选一）───────────────────────────────────────────
  //   "public"  只答公共题（类别名见 QUIZ_PUBLIC_CATEGORY）
  //   "custom"  只答 QUIZ_CATEGORIES 里列出的类别
  //   "all"     当天该厂区全部试卷
  QUIZ_SCOPE: "public",

  // 仅 QUIZ_SCOPE = "custom" 时生效
  QUIZ_CATEGORIES: ["公共题", "制剂生产"],

  // 仅 QUIZ_SCOPE = "public" 时生效，默认 "公共题"，一般无需修改
  QUIZ_PUBLIC_CATEGORY: "公共题",

  // 厂区（不配则用脚本默认的 TJ2，命令行 --factory 可临时覆盖）
  QUIZ_FACTORY: "TJ2",

  // 是否只处理 startTime 为「当天」的试卷；配 false 则处理所有未过期的
  QUIZ_ONLY_TODAY: true
};
