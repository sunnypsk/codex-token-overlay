export function formatProjectedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A'
  if (value > 999) return '>999%'
  const rounded = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/u, '')
  return `${rounded}%`
}
