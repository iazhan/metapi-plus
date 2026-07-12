import { isTokenExpiredError } from './alertRules.js';

export type AccountSessionRecoveryMode = 'strict' | 'broad';

export function shouldAttemptAccountSessionRecovery(
  message?: string | null,
  mode: AccountSessionRecoveryMode = 'strict',
): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  if (text.includes('未登录且未提供 access token')) return true;
  if (isTokenExpiredError({ message })) return true;

  const hasMissingNewApiUser = text.includes('new-api-user') && (
    text.includes('missing')
    || text.includes('required')
    || text.includes('未提供')
    || text.includes('缺少')
    || text.includes('需要')
  );
  if (hasMissingNewApiUser) return true;
  if (mode !== 'broad') return false;

  const hasInvalidSession = (
    text.includes('invalid')
    || text.includes('expired')
    || text.includes('无效')
    || text.includes('过期')
    || text.includes('失效')
  ) && (
    /\bsession\b/.test(text)
    || text.includes('会话')
    || text.includes('登录状态')
    || text.includes('凭证')
  );
  return (
    text.includes('unauthorized')
    || text.includes('not login')
    || text.includes('not logged')
    || text.includes('login required')
    || text.includes('please login')
    || text.includes('未登录')
    || text.includes('未授权')
    || hasInvalidSession
  );
}
