/**
 * SM2 请求体解密脚本
 *
 * 依赖：npm i sm-crypto
 * 运行：npx tsx sm2-decrypt.ts            使用文件内置的密文/私钥
 *       npx tsx sm2-decrypt.ts <密文hex>  临时解密指定密文
 *       VITE_SM_PRIVATE_KEY=xxx npx tsx sm2-decrypt.ts  用环境变量覆盖私钥
 *
 * 密文格式（与 sm-crypto / 常见国密后端一致）：
 *   hex 编码，C1(64字节，不含 04 前缀) + C3(32字节) + C2(明文长度)，即 cipherMode = 1 (C1C3C2)。
 *   解密得到的明文是 encodeURIComponent 后的 JSON，需要再解码一次。
 */

// @ts-ignore sm-crypto 未提供类型声明文件
import { sm2 } from 'sm-crypto'

// 避免依赖 @types/node 也能通过类型检查
declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
}

/** SM2 私钥，来自 .env 的 VITE_SM_PRIVATE_KEY */
const SM2_PRIVATE_KEY =
  process.env.VITE_SM_PRIVATE_KEY ||
  '8EDB615B1D48B8BE188FC0F18EC08A41DF50EA731FA28BF409E6552809E3A111'

/** 待解密的请求体密文 */
const DEFAULT_CIPHER_TEXT =
'043886daa1eb71b5e64a6517c5290bc86525d4eca0f537d98b8c3aa3fab6bc9fa5461d0db37066e83acaac899d7859a76bf57d85fb77e049e032284dcc798ca4adc7e7aa2ec969a761529b90b4b06a1c19ee41897f055f19229debaf18b01713cbc98e0a665545f2f43bad47ca8f5394aa426ae8bb4d3d508ce73c8ec9018c4184da07d7d664adacad2e7df95b6c72f603d765cc63980dec95dd6857ee6e8f6b6cbfd3e2a22e49c33433b00ad22753ea56f68cf4eb5d473d71ff0f67c0b8a042eeb00aa7d7fd03eb1b57b19c97e8a169f4bc540e8e862c4b59ab3b3b833368bd51eb4352080fc5d13a9260903f4f01e39c85a96d'
  // '28195860931127105d0fdc8d4dd3bcaf7b5956d8bae61787622cff6aabb3db4be08d6930902fa8e1ee7c2683c6c5192797a3e9c7b67189c8e3f0cc405a23b0ccac7d3271b45f0f8a5366dd8e6d1556ba8973e21d8edebfe8c89a6b8d5c2402a48631cd7863ef359bcc2576b944f8dfc39fe11f69c0372d5f5c17adc8531c3154c988c5c5ac0b60f220108c68c3b318eec27ea25acf47c01cd7f1251fcc2e8182bbbf304a8acc7c4db0450286e6117cc2e726c9a8eeb5ca5fb4d1f5c34f762d512b800956220a82a21e14a995e6b4cf70498117a5ad73e40b41b931a48ddc16ce3ee4f9d9885edb8f8a748c8c1c27063587ff8eaaae4911fe84fbc9ed8011bb8e35d789ae1816e29593d057336f52f7d179c6'

/** 明文若是 URL 编码则还原 */
function decodePlainText(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * 解密 SM2 密文
 * @param cipherText hex 密文，可带可不带 04 前缀
 * @param privateKey 32 字节 hex 私钥
 */
export function decryptSm2(cipherText: string, privateKey: string = SM2_PRIVATE_KEY): string {
  const hex = (cipherText || '').replace(/\s+/g, '').toLowerCase()
  if (!hex) throw new Error('密文为空')
  if (!privateKey) throw new Error('缺少 SM2 私钥（VITE_SM_PRIVATE_KEY）')

  // C1 可能带 04（未压缩点标识）前缀，两种形式都试一遍；cipherMode 1 = C1C3C2，0 = C1C2C3
  const candidates = hex.startsWith('04') ? [hex, hex.slice(2)] : [hex]

  for (const data of candidates) {
    for (const cipherMode of [1, 0]) {
      const plain = sm2.doDecrypt(data, privateKey.toLowerCase(), cipherMode)
      if (plain) return decodePlainText(plain)
    }
  }

  throw new Error('SM2 解密失败：密文可能不完整（被截断）、私钥不匹配或编码格式有误')
}

const cipherText = process.argv[2] || DEFAULT_CIPHER_TEXT
const plainText = decryptSm2(cipherText)

console.log('明文：')
console.log(plainText)

try {
  console.log('\n解析后的 JSON：')
  console.log(JSON.stringify(JSON.parse(plainText), null, 2))
} catch {
  // 明文不是 JSON 时忽略
}
