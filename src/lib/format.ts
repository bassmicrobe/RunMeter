const compactNumberFormatter = new Intl.NumberFormat("ja-JP", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const integerFormatter = new Intl.NumberFormat("ja-JP", {
  maximumFractionDigits: 0,
});

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCompactNumber(value: number) {
  return compactNumberFormatter.format(value);
}

export function formatInteger(value: number) {
  return integerFormatter.format(value);
}

export function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ミリ秒`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}秒`;

  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
}

export function formatClock(timestamp: string, timeZone = "UTC") {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(timestamp));
}

export function formatRelativeTime(timestamp: string, now: string) {
  const deltaSeconds = Math.max(
    0,
    Math.round((new Date(now).getTime() - new Date(timestamp).getTime()) / 1_000),
  );

  if (deltaSeconds < 5) return "たった今";
  if (deltaSeconds < 60) return `${deltaSeconds}秒前`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}分前`;
  return `${Math.floor(minutes / 60)}時間前`;
}

export function formatResetDate(timestamp: string, timeZone = "UTC") {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(timestamp));
}

export function formatTimeUntil(timestamp: string, now: string) {
  if (Date.parse(timestamp) <= Date.parse(now)) return "リセット時刻を過ぎました・更新待ち";

  const deltaMinutes = Math.max(
    0,
    Math.ceil((Date.parse(timestamp) - Date.parse(now)) / 60_000),
  );

  if (deltaMinutes <= 1) return "あと1分以内";
  if (deltaMinutes < 60) return `あと${deltaMinutes}分`;

  const hours = Math.floor(deltaMinutes / 60);
  const minutes = deltaMinutes % 60;
  if (hours < 24) {
    return minutes > 0 ? `あと${hours}時間${minutes}分` : `あと${hours}時間`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `あと${days}日${remainingHours}時間` : `あと${days}日`;
}
