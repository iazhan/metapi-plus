export const PRICE_REFRESH_DEFAULT_CRON = '0 0 * * *';
export const PRICE_REFRESH_DEFAULT_ENABLED = true;
export const PRICE_REFRESH_DEFAULT_SCHEDULE_MODE = 'cron' as const;
export const PRICE_REFRESH_DEFAULT_INTERVAL_HOURS = 6;

export function getPriceRefreshTimeZone(): string {
  return process.env.TZ?.trim() || 'Asia/Shanghai';
}
