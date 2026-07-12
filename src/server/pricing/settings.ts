export const PRICE_REFRESH_DEFAULT_CRON = '0 0 * * *';
export const PRICE_REFRESH_DEFAULT_ENABLED = true;

export function getPriceRefreshTimeZone(): string {
  return process.env.TZ?.trim() || 'Asia/Shanghai';
}
