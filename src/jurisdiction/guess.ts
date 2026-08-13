/**
 * Zero-network jurisdiction guessing. The plugin's privacy contract is "no
 * external origins", so instead of IP geolocation we read two things the
 * browser already knows:
 *
 *  1. `Intl.DateTimeFormat().resolvedOptions().timeZone` — IANA zone ids name
 *     actual cities (`America/Denver`, `America/Indiana/Indianapolis`), which
 *     maps to a US state for every US zone.
 *  2. `navigator.language` region subtag — a non-US locale (fr-FR, de-DE…)
 *     falls back to the INTL profile.
 *
 * This is a SUGGESTION rendered in the panel ("guessed from your browser") —
 * the dropdown always wins. A host that wants real IP geolocation can pass
 * its own default; that stays host integration, not plugin network access.
 */

const TZ_STATE: Record<string, string> = {
  'America/New_York': 'NY',
  'America/Detroit': 'MI',
  'America/Kentucky/Louisville': 'KY',
  'America/Kentucky/Monticello': 'KY',
  'America/Indiana/Indianapolis': 'IN',
  'America/Indiana/Vincennes': 'IN',
  'America/Indiana/Winamac': 'IN',
  'America/Indiana/Marengo': 'IN',
  'America/Indiana/Petersburg': 'IN',
  'America/Indiana/Vevay': 'IN',
  'America/Indiana/Tell_City': 'IN',
  'America/Indiana/Knox': 'IN',
  'America/Chicago': 'TX',
  'America/Menominee': 'MI',
  'America/North_Dakota/Center': 'ND',
  'America/North_Dakota/New_Salem': 'ND',
  'America/North_Dakota/Beulah': 'ND',
  'America/Denver': 'CO',
  'America/Boise': 'ID',
  'America/Phoenix': 'AZ',
  'America/Los_Angeles': 'CA',
  'America/Anchorage': 'AK',
  'America/Juneau': 'AK',
  'America/Sitka': 'AK',
  'America/Metlakatla': 'AK',
  'America/Yakutat': 'AK',
  'America/Nome': 'AK',
  'America/Adak': 'AK',
  'Pacific/Honolulu': 'HI',
}

export type JurisdictionGuess = {
  code: string
  /** Why we guessed it — shown next to the dropdown. */
  reason: string
}

export function guessJurisdiction(): JurisdictionGuess {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    const byTz = TZ_STATE[tz]
    if (byTz) return { code: byTz, reason: `guessed from timezone ${tz}` }
    const lang =
      typeof navigator !== 'undefined' ? (navigator.language ?? navigator.languages?.[0]) : ''
    const region = lang?.split('-')[1]?.toUpperCase()
    if (region === 'US') return { code: 'TX', reason: `US locale (${lang}), unknown state` }
    if (region) return { code: 'INTL', reason: `non-US locale (${lang})` }
  } catch {
    // SSR or restricted environment — fall through.
  }
  return { code: 'INTL', reason: 'no locale signal' }
}

/** Resolve the config value: 'AUTO' → the browser guess, else pass-through. */
export function resolveJurisdiction(configured: string): { code: string; auto: boolean } {
  if (configured !== 'AUTO') return { code: configured, auto: false }
  return { code: guessJurisdiction().code, auto: true }
}
