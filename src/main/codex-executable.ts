import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export async function findCodexExecutable(): Promise<string | null> {
  const candidates: string[] = []
  const explicit = process.env.CODEX_EXECUTABLE
  if (explicit) candidates.push(explicit)

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
    try {
      const entries = await readdir(binRoot, { withFileTypes: true })
      const versioned = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const path = join(binRoot, entry.name, 'codex.exe')
            try {
              return { path, modifiedAt: (await stat(path)).mtimeMs }
            } catch {
              return null
            }
          })
      )
      candidates.push(
        ...versioned
          .filter((entry): entry is { path: string; modifiedAt: number } => Boolean(entry))
          .sort((left, right) => right.modifiedAt - left.modifiedAt)
          .map((entry) => entry.path)
      )
    } catch {
      // Codex Desktop may not be installed in this location.
    }
  }

  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    candidates.push(join(userProfile, '.codex', '.sandbox-bin', 'codex.exe'))
  }

  for (const pathEntry of (process.env.PATH ?? '').split(delimiter)) {
    if (pathEntry) candidates.push(join(pathEntry, 'codex.exe'))
  }

  for (const candidate of unique(candidates)) {
    try {
      await access(candidate, constants.R_OK | constants.X_OK)
      if (candidate.toLowerCase().includes('windowsapps')) continue
      return candidate
    } catch {
      // Continue to the next candidate.
    }
  }

  return null
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
