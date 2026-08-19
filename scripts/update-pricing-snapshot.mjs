import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(root, 'assets', 'pricing', 'snapshot-manifest.json')
const files = {
  LiteLLM: join(root, 'assets', 'pricing', 'litellm-openai.json'),
  'models.dev': join(root, 'assets', 'pricing', 'models-dev-long.json'),
  'Fast facts': join(root, 'assets', 'pricing', 'fast-facts.json')
}
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.sources)) throw new Error('Invalid pricing snapshot manifest schema')
if (manifest.ccusageCommit !== '914b4f4a562040fa0c4bf8d4dc7f3ae27d70e73c') throw new Error('Unexpected ccusage pin')
for (const source of manifest.sources) {
  const path = files[source.name]
  if (!path || typeof source.url !== 'string' || !/^https:\/\//u.test(source.url)) throw new Error(`Invalid source metadata for ${source.name}`)
  const content = await readFile(path)
  const parsed = JSON.parse(content)
  if (source.name === 'Fast facts') {
    for (const [model, fact] of Object.entries(parsed)) {
      if (!/^\d+$/.test(fact.numerator) || !/^\d+$/.test(fact.denominator) || BigInt(fact.denominator) <= 0n) throw new Error(`Invalid Fast fact for ${model}`)
    }
  } else {
    for (const [model, rate] of Object.entries(parsed)) {
      if (!model || typeof rate !== 'object' || rate === null) throw new Error(`Invalid pricing rate for ${model}`)
    }
  }
  validatePricingNumbers(parsed, source.name)
  source.sha256 = createHash('sha256').update(content).digest('hex')
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

function validatePricingNumbers(value, sourceName, path = sourceName) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validatePricingNumbers(child, sourceName, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (/(?:cost|input|output|prompt|completion|cache|tokens)/iu.test(key) && (typeof child === 'number' || typeof child === 'string')) {
      const numeric = Number(child)
      if (!Number.isFinite(numeric) || numeric < 0) throw new Error(`Invalid non-negative pricing value at ${childPath}`)
    }
    validatePricingNumbers(child, sourceName, childPath)
  }
}
