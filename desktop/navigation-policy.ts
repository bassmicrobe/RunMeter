export const APP_URL = "https://run-meter.vercel.app/";
const APP_ORIGIN = new URL(APP_URL).origin;

const EXTERNAL_ORIGINS = new Set([
  APP_ORIGIN,
  "https://chatgpt.com",
  "https://auth.openai.com",
  "https://claude.ai",
  "https://console.anthropic.com",
  "https://cybereye-tech.jp",
]);

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

export function isTrustedAppUrl(value: string): boolean {
  return parseHttpsUrl(value)?.origin === APP_ORIGIN;
}

export function isAllowedExternalUrl(value: string): boolean {
  const url = parseHttpsUrl(value);
  if (!url) return false;
  if (EXTERNAL_ORIGINS.has(url.origin)) return true;
  return false;
}

export function canGrantPermission(
  permission: string,
  requestingUrl: string,
  isMainFrame: boolean,
  topLevelUrl: string,
): boolean {
  return (
    permission === "clipboard-sanitized-write" &&
    isMainFrame &&
    isTrustedAppUrl(requestingUrl) &&
    isTrustedAppUrl(topLevelUrl)
  );
}
