import type { AnswerSpeed } from '@shared/ipc'
import type { UiLanguage } from '@shared/i18n'
import type { I18n } from '../i18n'

/**
 * Format the per-answer speed line (#290): `42 tok/s · 1.8 s to first token · 615 tokens`.
 * Rounding rule from the issue: no decimals at or above 10 tok/s, one decimal below; time to
 * first token in seconds with one decimal; the token count as a whole number. Every number goes
 * through the UI language so German reads "1,8 s" and "1.024 Token" (M-U5). Pure — one
 * definition shared by the transcript and its render test.
 */
export function formatAnswerSpeed(speed: AnswerSpeed, t: I18n['t'], lang: UiLanguage): string {
  const tps =
    speed.tokensPerSecond >= 10
      ? Math.round(speed.tokensPerSecond).toLocaleString(lang, { maximumFractionDigits: 0 })
      : speed.tokensPerSecond.toLocaleString(lang, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1
        })
  const ttft = (speed.ttftMs / 1000).toLocaleString(lang, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  })
  const tokens = Math.round(speed.tokens).toLocaleString(lang, { maximumFractionDigits: 0 })
  return t('chat.speed.line', { tps, ttft, tokens })
}
