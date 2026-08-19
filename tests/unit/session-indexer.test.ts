import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionIndexer } from '../../src/main/session-indexer.js'
import { StateStore } from '../../src/main/state.js'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('SessionIndexer', () => {
  it('indexes cumulative token deltas once and tails appended events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-overlay-test-'))
    temporaryPaths.push(root)
    const sessions = join(root, 'sessions', '2026', '08', '19')
    await mkdir(sessions, { recursive: true })
    const sessionId = '01a00000-0000-7000-8000-000000000001'
    const file = join(sessions, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
    await writeFile(
      file,
      [
        JSON.stringify({ timestamp: '2026-08-19T02:00:00.000Z', type: 'session_meta', payload: { id: sessionId } }),
        JSON.stringify({ timestamp: '2026-08-19T02:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
        tokenLine('2026-08-19T02:00:02.000Z', 100, 60, 10, 110, 25),
        ''
      ].join('\n'),
      'utf8'
    )

    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('110')

    await appendFile(file, `${tokenLine('2026-08-19T02:00:03.000Z', 160, 100, 20, 180, 26)}\n`, 'utf8')
    await indexer.scan()
    const session = store.get().sessions[sessionId]!
    expect(session.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('180')
    expect(session.eventCount).toBe(2)

    await indexer.scan()
    expect(session.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('180')
  })
})

function tokenLine(
  timestamp: string,
  input: number,
  cached: number,
  output: number,
  total: number,
  usedPercent: number
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 5,
          total_tokens: total
        },
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 5,
          total_tokens: total
        }
      },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1787275289 }
      }
    }
  })
}
