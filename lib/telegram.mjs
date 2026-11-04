// Telegram delivery for keeper alerts. The bot token is part of Telegram's URL, so nothing here ever reports the URL,
// the request, or a raw fetch error.
import { redactSecrets } from "./keeper-alerts.mjs";

const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/, CHAT = /^-?\d{1,20}$/;
const MAX_RETRY_AFTER_SECONDS = 30;

/** @returns {{ token: string, chatId: string } | null} null when Telegram is not configured. */
export function telegramConfig(env) {
  const token = env.HYMET_TELEGRAM_BOT_TOKEN?.trim(), chatId = env.HYMET_TELEGRAM_CHAT_ID?.trim();
  if (!token && !chatId) return null;
  if (!token || !TOKEN.test(token)) throw Error("HYMET_TELEGRAM_BOT_TOKEN is missing or malformed");
  if (!chatId || !CHAT.test(chatId)) throw Error("HYMET_TELEGRAM_CHAT_ID is missing or malformed");
  return { token, chatId };
}

/**
 * Sends plain text (no parse mode, so error text cannot break formatting or inject markup). Waits out one rate limit;
 * any other failure throws a sanitized error and the caller retries on its next run.
 */
export async function sendTelegram(config, text, { silent = false, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true, disable_notification: silent }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const code = e?.cause?.code ?? e?.name ?? "network error";
      throw Error(`Telegram request failed (${code})`);
    }
    if (response.ok) return;
    const body = await response.json().catch(() => ({}));
    const wait = Number(body?.parameters?.retry_after);
    if (response.status === 429 && attempt === 0 && wait > 0 && wait <= MAX_RETRY_AFTER_SECONDS) {
      await sleep(wait * 1000);
      continue;
    }
    throw Error(`Telegram answered HTTP ${response.status}${body?.description ? `: ${redactSecrets(body.description).slice(0, 200)}` : ""}`);
  }
}
