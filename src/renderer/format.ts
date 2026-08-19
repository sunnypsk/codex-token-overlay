export function formatTokens(value: string | bigint, maximumDecimals = 2): string {
  const tokens = typeof value === 'bigint' ? value : safeBigInt(value)
  const absolute = tokens < 0n ? -tokens : tokens
  const units: Array<[bigint, string]> = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K']
  ]
  for (const [divisor, suffix] of units) {
    if (absolute >= divisor) {
      const factor = 10n ** BigInt(maximumDecimals)
      const scaled = (absolute * factor + divisor / 2n) / divisor
      const whole = scaled / factor
      const fraction = (scaled % factor).toString().padStart(maximumDecimals, '0').replace(/0+$/u, '')
      const sign = tokens < 0n ? '-' : ''
      return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}${suffix}`
    }
  }
  return tokens.toLocaleString('en-US')
}

export function formatExactTokens(value: string): string {
  return safeBigInt(value).toLocaleString('en-US')
}

export function formatMicroUsd(value: string | null): string {
  if (value === null) return 'N/A'
  const micro = safeBigInt(value)
  const cents = (micro + 5_000n) / 10_000n
  const dollars = cents / 100n
  const fraction = (cents % 100n).toString().padStart(2, '0')
  return `~$${dollars.toLocaleString('en-US')}.${fraction}`
}

export function formatResetDate(iso: string | null): string {
  if (!iso) return 'Unavailable'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(iso))
}

export function formatCountdown(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return 'Reset unavailable'
  const remaining = Math.max(0, Date.parse(iso) - nowMs)
  const totalMinutes = Math.floor(remaining / 60_000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function formatFreshness(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return 'Never'
  const elapsed = Math.max(0, nowMs - Date.parse(iso))
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

export function safeBigInt(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}
