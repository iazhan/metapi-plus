/**
 * models.dev 中可作为模型原厂计价来源的 provider ID。
 * 托管、聚合、路由和转售平台仍可保留在原始快照中，但不参与有效价格解析。
 */
export const FIRST_PARTY_MODEL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'alibaba',
  'alibaba-cn',
  'anthropic',
  'cohere',
  'deepseek',
  'google',
  'inception',
  'meta',
  'llama',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'openai',
  'perplexity',
  'poolside',
  'sarvam',
  'stepfun',
  'stepfun-ai',
  'xiaomi',
  'xai',
  'zai',
  'zhipuai',
]);

/**
 * 判断 provider 是否属于模型原厂计价来源。
 * provider ID 会按大小写无关、去首尾空格的形式比较；空值和未知 ID 返回 false。
 */
export function isFirstPartyModelProvider(providerId: string | null | undefined): boolean {
  return typeof providerId === 'string'
    && FIRST_PARTY_MODEL_PROVIDER_IDS.has(providerId.trim().toLowerCase());
}
