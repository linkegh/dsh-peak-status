/**
 * Host half of the DeepSeek peak/off-peak status plugin.
 *
 * It owns three facts and publishes them on a read-only HTTP route the Client
 * half polls:
 *   - the DeepSeek API price phase (peak / off-peak) and the next switch,
 *   - the signed-in DeepSeek account balance,
 *   - which live sessions are currently running work,
 *   - whether the user already asked for a wrap-up ("暂停") in a session.
 *
 * It also contributes the wrap-up protocol to the system prompt, so a model
 * that receives the user's "暂停" reply writes a handoff document and stops.
 */

/** China Standard Time is UTC+8 all year: no daylight saving exists there. */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** The route the Client half polls. Router paths are a composition contract. */
const STATUS_PATH = '/peak-status/state'

/** Balance is queried from the DeepSeek Platform, so cache it briefly. */
const BALANCE_TTL_MS = 60_000

/** How long a pause request stays worth showing in the UI. */
const PAUSE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Peak blocks in Beijing wall-clock time: 09:00-12:00 and 14:00-18:00
 * (the API docs state 01:00-04:00 and 06:00-10:00 UTC).
 */
const PEAK_BLOCKS = [
  [9, 0, 12, 0],
  [14, 0, 18, 0],
]

/**
 * Chinese public holidays, full days, Beijing date. DeepSeek bills every
 * weekend and every public holiday at the off-peak rate, including make-up
 * working weekends, so only whole holiday days belong here. Update this table
 * when the State Council publishes the next year's arrangement (2027 is not
 * announced at the time of writing).
 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

const WRAP_UP_PROTOCOL = [
  '## 峰谷价收尾协议（DeepSeek API）',
  '',
  '本会话所在 Harness 已启用「峰谷价状态」插件。DeepSeek API 在高峰时段（北京时间周一至周五 09:00–12:00、14:00–18:00，中国法定节假日与周末除外）按谷时 2 倍价格计费；其余时间为谷价。高峰时段工作时，界面会向用户显示一条提醒：「回复 暂停 可优雅收尾」。',
  '',
  '- 若用户在该提醒下回复「暂停」（通常只有这两个字，也可能是「暂停并收尾」），立即进入收尾模式，不要继续推进原任务：',
  '  1. 停止开始任何新工作，除写交接文档外不再调用其他工具；',
  '  2. 立即用 write 工具在会话工作目录写入交接文档 `HANDOFF.md`（已存在则覆盖），内容必须包含：任务目标与背景、已完成事项、未完成事项、下一步建议、关键文件及用途、已运行的重要命令与结果、风险与注意事项、恢复工作时的第一条指令；',
  '  3. 回复一句简短确认（交接文档路径 + 一句话现状），然后结束本轮，不要再调用工具。',
  '- 用户没有回复「暂停」时照常推进，不要主动提起这条提醒。',
  '- 谷价时段用户说「暂停」时，按普通指令理解。',
].join('\n')

/**
 * CNY prices per 1M tokens, [off-peak, peak], from the DeepSeek pricing page
 * (deepseek-flash and deepseek-v4-pro, 2026-10 rate card). Peak is exactly 2x.
 */
const PRICE_TABLE = {
  flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  pro: { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
}

/**
 * Years the holiday table covers. The table is the only usable source because
 * DeepSeek bills the official vacation window, which is an administrative
 * decision published per year, not something a calendar algorithm can derive.
 */
const HOLIDAY_YEARS = [...new Set([...HOLIDAYS].map((entry) => Number(entry.slice(0, 4))))].sort((a, b) => a - b)

function priceTableFor(model) {
  const name = String(model || '').toLowerCase()
  if (name.includes('pro')) return { id: 'deepseek-v4-pro', table: PRICE_TABLE.pro }
  return { id: 'deepseek-flash', table: PRICE_TABLE.flash }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Beijing wall-clock parts of an instant, independent of the Host time zone. */
function beijingParts(ms) {
  const shifted = new Date(ms + CN_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

function dayKey(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Epoch milliseconds of a Beijing wall-clock date and time. */
function beijingEpoch(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - CN_OFFSET_MS
}

function isPeakAt(ms) {
  const parts = beijingParts(ms)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (HOLIDAYS.has(dayKey(parts.year, parts.month, parts.day))) return false
  const minutes = parts.hour * 60 + parts.minute
  return PEAK_BLOCKS.some(([startHour, startMinute, endHour, endMinute]) => {
    return minutes >= startHour * 60 + startMinute && minutes < endHour * 60 + endMinute
  })
}

/** The first instant after `ms` where the price phase flips, and the new phase. */
function nextSwitch(ms) {
  const current = isPeakAt(ms)
  const start = beijingParts(ms)
  const midnight = beijingEpoch(start.year, start.month, start.day)
  for (let offset = 0; offset <= 16; offset += 1) {
    const day = beijingParts(midnight + offset * DAY_MS)
    for (const [hour, minute] of [[9, 0], [12, 0], [14, 0], [18, 0]]) {
      const candidate = beijingEpoch(day.year, day.month, day.day, hour, minute)
      if (candidate <= ms) continue
      const phase = isPeakAt(candidate)
      if (phase !== current) {
        return { at: candidate, peak: phase }
      }
    }
  }
  // Unreachable for the real schedule; keeps the payload well formed.
  return { at: ms + 60 * 60 * 1000, peak: !current }
}

function messageText(data) {
  const content = data && data.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function agentId(agent) {
  try {
    const id = agent && (agent.id ?? (agent.session && agent.session.id))
    return id === undefined || id === null ? undefined : String(id)
  } catch {
    return undefined
  }
}

function agentStatus(agent) {
  try {
    return agent && agent.status
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  /** sessionId -> timestamp of the user's "暂停" reply. */
  const pausedAt = new Map()
  /** sessionId -> last status seen on the `agent/status` feed. */
  const liveStatus = new Map()
  /** Cached balance payload plus its timestamp. */
  let balanceCache = { at: 0, value: undefined }
  /** sessionId -> { seq, value }: Token folds are skipped while the log is unchanged. */
  const usageCache = new Map()

  const prune = (map, ttl) => {
    const floor = Date.now() - ttl
    for (const [key, value] of map) {
      if (typeof value === 'number' && value < floor) map.delete(key)
    }
  }

  ctx.on('session/event', (...args) => {
    const event = args.find((value) => value && typeof value.type === 'string' && typeof value.seq === 'number')
    const session = args.find((value) => {
      return value && value !== event && typeof value === 'object' && typeof value.id === 'string'
    })
    if (!event || !session) return
    if (event.type !== 'user/message') return
    const text = messageText(event.data).trim()
    if (!text) return
    const id = String(session.id)
    if (/^暂停/.test(text)) {
      pausedAt.set(id, Date.now())
      prune(pausedAt, PAUSE_TTL_MS)
    } else {
      pausedAt.delete(id)
    }
  })

  ctx.on('agent/status', (...args) => {
    const payload = args.find((value) => value && typeof value === 'object' && value.agent && value.status)
    if (!payload) return
    const id = agentId(payload.agent)
    if (id) liveStatus.set(id, payload.status)
  })

  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => scoped.systemPrompt.section({
      name: 'peak-price-wrap-up',
      order: 640,
      text: WRAP_UP_PROTOCOL,
    }))
  })

  const runningSessions = () => {
    const ids = new Set()
    const agents = ctx.get('agents')
    if (agents && typeof agents.list === 'function') {
      for (const agent of agents.list()) {
        const id = agentId(agent)
        if (!id) continue
        if (agentStatus(agent) === 'running') ids.add(id)
      }
    }
    for (const [id, status] of liveStatus) {
      if (status === 'running') ids.add(id)
    }
    return ids
  }

  /** Fold one live session's durable log into request/Token counters. */
  const readUsage = (sessionId) => {
    const sessions = ctx.get('sessions')
    const session = sessions && sessionId && typeof sessions.get === 'function'
      ? sessions.get(sessionId)
      : undefined
    if (!session) return { available: false, reason: 'not-live' }
    const seq = typeof session.seq === 'number' ? session.seq : -1
    const cached = usageCache.get(sessionId)
    if (cached && cached.seq === seq) return cached.value
    let events = []
    try {
      events = session.snapshotEvents ? session.snapshotEvents() : []
    } catch {
      events = []
    }
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      requests: 0,
      toolCalls: 0,
      turns: 0,
      steps: 0,
    }
    let model
    let provider
    let lastAt = 0
    let costCNY = 0
    let costPeakCNY = 0
    let costOffCNY = 0
    let pricedAs = null
    for (const event of events) {
      if (!event) continue
      if (event.type === 'assistant/message') {
        totals.requests += 1
        const data = event.data || {}
        const usage = data.usage
        const source = data.message && data.message.source
        if (source) {
          model = source.model || model
          provider = source.provider || provider
        }
        if (usage && typeof usage === 'object') {
          const miss = Number(usage.inputTokens) || 0
          const hit = Number(usage.cacheReadTokens) || 0
          const out = Number(usage.outputTokens) || 0
          totals.inputTokens += miss
          totals.outputTokens += out
          totals.cacheReadTokens += hit
          totals.cacheWriteTokens += Number(usage.cacheWriteTokens) || 0
          totals.reasoningTokens += Number(usage.reasoningTokens) || 0
          // Each request is priced at the phase it actually ran in.
          const priced = priceTableFor(source && source.model ? source.model : model)
          pricedAs = priced.id
          const index = isPeakAt(typeof event.time === 'number' ? event.time : Date.now()) ? 1 : 0
          const spend = (miss * priced.table.miss[index] + hit * priced.table.hit[index] + out * priced.table.out[index]) / 1e6
          costCNY += spend
          if (index === 1) costPeakCNY += spend
          else costOffCNY += spend
        }
        if (typeof event.time === 'number' && event.time > lastAt) lastAt = event.time
      } else if (event.type === 'tool/call') {
        totals.toolCalls += 1
      } else if (event.type === 'turn/start') {
        totals.turns += 1
      } else if (event.type === 'step/start') {
        totals.steps += 1
      }
    }
    const value = {
      available: true,
      sessionId,
      model: model || null,
      provider: provider || null,
      lastAt: lastAt || null,
      events: events.length,
      // Cache-hit input is reported separately and dwarfs the uncached part,
      // so the two are kept apart and summed explicitly for the totals.
      promptTokens: totals.inputTokens + totals.cacheReadTokens,
      totalTokens: totals.inputTokens + totals.cacheReadTokens + totals.outputTokens,
      costCNY,
      costPeakCNY,
      costOffCNY,
      pricedAs,
      ...totals,
    }
    usageCache.set(sessionId, { seq, value })
    return value
  }

  const readBalance = async () => {
    if (balanceCache.value && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.value
    }
    const finish = (value) => {
      balanceCache = { at: Date.now(), value }
      return value
    }
    const account = ctx.get('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') {
      return finish({ status: 'unavailable', reason: 'no-account-service' })
    }
    let state
    try {
      state = await account.getState()
    } catch (error) {
      return finish({ status: 'error', reason: String((error && error.message) || error) })
    }
    if (!state || state.status !== 'credential-stored') {
      return finish({ status: 'unavailable', reason: 'signed-out' })
    }
    try {
      const balance = await account.getBalance({
        version: '1.0.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: 8 * 60 * 60,
      })
      if (!balance) return finish({ status: 'unavailable', reason: 'signed-out' })
      if (balance.status !== 'ready') return finish({ status: 'error', reason: 'platform-failed' })
      return finish({
        status: 'ready',
        wallets: balance.value || [],
        bonusWallets: balance.bonusWallets || [],
      })
    } catch (error) {
      return finish({ status: 'error', reason: String((error && error.message) || error) })
    }
  }

  const snapshot = async (sessionId) => {
    const now = Date.now()
    const peak = isPeakAt(now)
    const next = nextSwitch(now)
    const running = runningSessions()
    const balance = await readBalance()
    const paused = []
    for (const [id, at] of pausedAt) {
      if (now - at < PAUSE_TTL_MS) paused.push({ id, at })
    }
    return {
      ok: true,
      now,
      peak,
      phase: peak ? 'peak' : 'off',
      nextSwitchAt: next.at,
      nextPhase: next.peak ? 'peak' : 'off',
      zone: 'Asia/Shanghai',
      running: running.size > 0,
      runningSessions: [...running],
      paused,
      holidayYears: HOLIDAY_YEARS,
      holidayCovered: HOLIDAY_YEARS.includes(beijingParts(now).year),
      session: sessionId ? {
        id: sessionId,
        running: running.has(sessionId),
        paused: paused.some((entry) => entry.id === sessionId),
      } : null,
      balance,
      balanceAt: balanceCache.at,
      usage: sessionId ? readUsage(sessionId) : null,
    }
  }

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: async (req, res) => {
        // The Harness page itself is admitted by the connection layer; this
        // route is a plain named route, so it accepts only same-origin callers
        // and never advertises a CORS grant (the payload carries the balance).
        const site = req.headers && req.headers['sec-fetch-site']
        if (site && site !== 'same-origin' && site !== 'none') {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          res.end('cross-site request refused')
          return
        }
        let body
        try {
          const url = new URL(req.url || STATUS_PATH, 'http://localhost')
          const sessionId = url.searchParams.get('session') || undefined
          body = JSON.stringify(await snapshot(sessionId))
        } catch (error) {
          body = JSON.stringify({ ok: false, error: String((error && error.message) || error) })
        }
        const payload = Buffer.from(body, 'utf8')
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': payload.length,
        })
        res.end(payload)
      },
    }))
  })
}
