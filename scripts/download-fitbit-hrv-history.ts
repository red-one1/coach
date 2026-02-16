import 'dotenv/config'

/**
 * Temporary utility: download historical Fitbit HRV (1 sample/day where available).
 *
 * Examples:
 *   pnpm tsx scripts/download-fitbit-hrv-history.ts --email you@example.com
 *   pnpm tsx scripts/download-fitbit-hrv-history.ts --user-id <uuid> --max-days 7300 --chunk-days 30
 *
 * Options:
 *   --email <email>      Find user by email (or use --user-id)
 *   --user-id <id>       Find user by id (or use --email)
 *   --end-date <YYYY-MM-DD>  End date (default: today UTC)
 *   --max-days <n>       How far back to request (default: 3650)
 *   --chunk-days <n>     Fitbit HRV window per request, max 30 (default: 30)
 *   --out-dir <path>     Output directory (default: tmp)
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '../server/utils/db'
import { refreshFitbitToken } from '../server/utils/fitbit'

type FitbitHrvDay = {
  dateTime: string
  value?: {
    dailyRmssd?: number
    deepRmssd?: number
    coverage?: string
    [key: string]: unknown
  }
}

type FitbitHrvResponse = {
  hrv?: FitbitHrvDay[]
}

type CliOptions = {
  userId?: string
  email?: string
  endDate: string
  startDate?: string
  maxDays: number
  chunkDays: number
  outDir: string
}

type DailyHrvRow = {
  date: string
  dailyRmssd: number | null
  deepRmssd: number | null
  coverage: string | null
  rawValue: Record<string, unknown> | null
}

const FITBIT_API_BASE = 'https://api.fitbit.com'

function parseArgs(argv: string[]): CliOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag)
    if (idx === -1) return undefined
    return argv[idx + 1]
  }

  const userId = getValue('--user-id')
  const email = getValue('--email')
  const endDate = getValue('--end-date') || new Date().toISOString().slice(0, 10)
  const startDate = getValue('--start-date')
  const maxDays = Number(getValue('--max-days') || 3650)
  const chunkDays = Number(getValue('--chunk-days') || 30)
  const outDir = getValue('--out-dir') || 'tmp'

  if (!userId && !email) {
    throw new Error('Pass either --user-id <id> or --email <email>')
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('Invalid --end-date format. Use YYYY-MM-DD')
  }

  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    throw new Error('Invalid --start-date format. Use YYYY-MM-DD')
  }

  if (!Number.isFinite(maxDays) || maxDays <= 0) {
    throw new Error('--max-days must be a positive number')
  }

  if (!Number.isFinite(chunkDays) || chunkDays <= 0 || chunkDays > 30) {
    throw new Error('--chunk-days must be between 1 and 30 (Fitbit HRV endpoint limit)')
  }

  return {
    userId,
    email,
    endDate,
    startDate,
    maxDays,
    chunkDays,
    outDir
  }
}

function toDateStringUTC(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

function clampRangeStart(end: Date, chunkDays: number, absoluteStart: Date): Date {
  const rawStart = addUtcDays(end, -(chunkDays - 1))
  return rawStart < absoluteStart ? absoluteStart : rawStart
}

function isExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) return false
  const bufferMs = 5 * 60 * 1000
  return Date.now() >= new Date(expiresAt.getTime() - bufferMs).getTime()
}

async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  const response = await fetch(url, options)

  if (response.status >= 500 && response.status <= 599 && retries > 0) {
    const waitMs = Math.max(1000, (4 - retries) * 2000)
    console.warn(
      `Server ${response.status} from Fitbit. Retrying in ${Math.ceil(waitMs / 1000)}s...`
    )
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return fetchWithRetry(url, options, retries - 1)
  }

  if (response.status !== 429 || retries <= 0) {
    return response
  }

  const retryAfter = response.headers.get('Retry-After')
  const resetHeader =
    response.headers.get('fitbit-rate-limit-reset') || response.headers.get('rate-limit-reset')

  let waitMs = 15_000
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds > 0) waitMs = seconds * 1000
  } else if (resetHeader) {
    const seconds = Number(resetHeader)
    if (Number.isFinite(seconds) && seconds > 0) waitMs = seconds * 1000
  }

  console.warn(`429 rate limit hit. Waiting ${Math.ceil(waitMs / 1000)}s before retry...`)
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  return fetchWithRetry(url, options, retries - 1)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  const user = opts.userId
    ? await prisma.user.findUnique({
        where: { id: opts.userId },
        select: { id: true, email: true }
      })
    : await prisma.user.findUnique({
        where: { email: opts.email! },
        select: { id: true, email: true }
      })

  if (!user) {
    throw new Error('User not found')
  }

  let integration = await prisma.integration.findUnique({
    where: {
      userId_provider: {
        userId: user.id,
        provider: 'fitbit'
      }
    }
  })

  if (!integration) {
    throw new Error(`No Fitbit integration found for user ${user.id}`)
  }

  if (!integration.accessToken) {
    throw new Error('Fitbit integration has no access token')
  }

  if (isExpired(integration.expiresAt)) {
    console.log('Refreshing expired Fitbit token...')
    integration = await refreshFitbitToken(integration)
  }

  const end = new Date(`${opts.endDate}T00:00:00.000Z`)
  const derivedStart = addUtcDays(end, -(opts.maxDays - 1))
  const explicitStart = opts.startDate ? new Date(`${opts.startDate}T00:00:00.000Z`) : null
  const absoluteStart = explicitStart && explicitStart > derivedStart ? explicitStart : derivedStart

  console.log('='.repeat(60))
  console.log('Fitbit HRV history download (temporary script)')
  console.log(`User: ${user.email} (${user.id})`)
  console.log(`Range target: ${toDateStringUTC(absoluteStart)} -> ${toDateStringUTC(end)}`)
  console.log(`Chunk size: ${opts.chunkDays} day(s)`)
  console.log('='.repeat(60))

  const byDate = new Map<string, DailyHrvRow>()
  let cursorEnd = new Date(end)
  let requests = 0

  while (cursorEnd >= absoluteStart) {
    const chunkStart = clampRangeStart(cursorEnd, opts.chunkDays, absoluteStart)
    const startStr = toDateStringUTC(chunkStart)
    const endStr = toDateStringUTC(cursorEnd)

    const path = `/1/user/-/hrv/date/${startStr}/${endStr}.json`
    const url = `${FITBIT_API_BASE}${path}`

    const response = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${integration.accessToken}`,
        Accept: 'application/json'
      }
    })

    requests++

    if (response.status === 401) {
      console.log('Token expired mid-run, refreshing and retrying current chunk...')
      integration = await refreshFitbitToken(integration)
      continue
    }

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Fitbit API failed for ${startStr}..${endStr}: ${response.status} ${text}`)
    }

    const data = (await response.json()) as FitbitHrvResponse
    const rows = data.hrv || []

    for (const row of rows) {
      const value = row.value || {}
      byDate.set(row.dateTime, {
        date: row.dateTime,
        dailyRmssd:
          typeof value.dailyRmssd === 'number' && Number.isFinite(value.dailyRmssd)
            ? value.dailyRmssd
            : null,
        deepRmssd:
          typeof value.deepRmssd === 'number' && Number.isFinite(value.deepRmssd)
            ? value.deepRmssd
            : null,
        coverage: typeof value.coverage === 'string' ? value.coverage : null,
        rawValue: value as Record<string, unknown>
      })
    }

    console.log(`[${requests}] ${startStr}..${endStr} -> ${rows.length} day(s)`)

    cursorEnd = addUtcDays(chunkStart, -1)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))

  await mkdir(opts.outDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const slug = (user.email || user.id).replace(/[^a-zA-Z0-9_-]/g, '_')

  const jsonPath = join(opts.outDir, `fitbit-hrv-${slug}-${stamp}.json`)
  const csvPath = join(opts.outDir, `fitbit-hrv-${slug}-${stamp}.csv`)

  await writeFile(jsonPath, JSON.stringify(sorted, null, 2), 'utf8')

  const csvHeader = 'date,dailyRmssd,deepRmssd,coverage\n'
  const csvBody = sorted
    .map((r) => [r.date, r.dailyRmssd ?? '', r.deepRmssd ?? '', r.coverage ?? ''].join(','))
    .join('\n')
  await writeFile(csvPath, csvHeader + csvBody + '\n', 'utf8')

  const nonNullDays = sorted.filter((r) => r.dailyRmssd !== null || r.deepRmssd !== null).length

  console.log('='.repeat(60))
  console.log(`Completed. Requests: ${requests}`)
  console.log(`Unique HRV days returned: ${sorted.length}`)
  console.log(`Days with at least one HRV metric: ${nonNullDays}`)
  console.log(`JSON: ${jsonPath}`)
  console.log(`CSV : ${csvPath}`)
  console.log('='.repeat(60))
}

main()
  .catch((error) => {
    console.error('Download failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
