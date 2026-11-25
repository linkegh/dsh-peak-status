/**
 * Client half of the DeepSeek peak/off-peak status plugin.
 *
 * Renders two surfaces, both fed by the Host half's read-only JSON route:
 *   - a centered status pill in the conversation header (clock, price phase,
 *     countdown to the next switch, account balance). Hovering opens a detail
 *     popover that re-renders in place instead of a native `title` tooltip,
 *     and double-clicking opens the balance / Token panel;
 *   - a wrap-up reminder overlay raised once per peak block while the agent
 *     works during peak hours; it waits for the user's confirmation instead of
 *     expiring on a timer.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-peak-status',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    const STATUS_URL = '/peak-status/state'
    const POPOVER_WIDTH = 460
    const REMIND_KEY_PREFIX = 'dsh.peak-status.reminded.'

    /** One reminder per peak block, remembered across page reloads. */
    function hasReminded(key) {
      try {
        return window.localStorage.getItem(REMIND_KEY_PREFIX + key) === '1'
      } catch {
        return false
      }
    }

    function markReminded(key) {
      try {
        window.localStorage.setItem(REMIND_KEY_PREFIX + key, '1')
      } catch {
        // Private mode or a blocked storage area: the in-memory ref still
        // prevents repeats for this page load.
      }
    }

    const color = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-2)',
      overlay: 'var(--dsw-alias-bg-overlay)',
      peak: 'var(--dsw-alias-state-warn-primary)',
      off: 'var(--dsw-alias-state-success-primary)',
    }

    const pad2 = (value) => String(value).padStart(2, '0')
    const nf = new Intl.NumberFormat('zh-CN')
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? nf.format(value) : '—')

    function formatClock(ms) {
      const date = new Date(ms)
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    }

    function formatCountdown(ms) {
      if (!(ms > 0)) return '即将切换'
      const total = Math.floor(ms / 1000)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (days > 0) return `${days}天${hours}小时`
      if (hours > 0) return `${hours}小时${pad2(minutes)}分`
      return `${minutes}分${pad2(seconds)}秒`
    }

    function compactCountdown(ms) {
      if (!(ms > 0)) return '0m'
      const total = Math.floor(ms / 1000)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return `${days}d${hours}h`
      if (hours > 0) return `${hours}h${pad2(minutes)}m`
      return `${minutes}m`
    }

    function formatCost(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value === 0) return '¥0.00'
      if (value < 0.01) return `¥${value.toFixed(4)}`
      return `¥${value.toFixed(2)}`
    }

    function switchLabel(ts, nowMs) {
      const target = new Date(ts)
      const current = new Date(nowMs)
      const hm = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`
      if (target.toDateString() === current.toDateString()) return `今天 ${hm}`
      const tomorrow = new Date(nowMs + 86400000)
      if (target.toDateString() === tomorrow.toDateString()) return `明天 ${hm}`
      return `${target.getMonth() + 1}月${target.getDate()}日 ${hm}`
    }

    /** Platform balances arrive as high-precision strings; show cents. */
    function formatAmount(raw) {
      const value = Number(raw)
      if (!Number.isFinite(value)) return String(raw === undefined ? '' : raw)
      const fixed = value.toFixed(2)
      if (value !== 0 && fixed === '0.00') return value.toFixed(4)
      return fixed
    }

    const symbolOf = (currency) => (currency === 'USD' ? '$' : '¥')

    function walletLabel(balance) {
      if (!balance) return '--'
      if (balance.status === 'ready') {
        const wallets = Array.isArray(balance.wallets) ? balance.wallets : []
        if (wallets.length === 0) return '--'
        const wallet = wallets.find((entry) => entry && entry.currency === 'CNY') || wallets[0]
        return `${symbolOf(wallet.currency)}${formatAmount(wallet.balance)}`
      }
      if (balance.status === 'unavailable' && balance.reason === 'signed-out') return '未登录'
      return '--'
    }

    function phaseOf(status) {
      if (!status) return null
      // A poll can be one interval stale; the countdown already crossed the
      // switch, so show the phase the Host scheduled next.
      if (typeof status.nextSwitchAt === 'number' && Date.now() >= status.nextSwitchAt) {
        return status.nextPhase === 'peak' ? 'peak' : 'off'
      }
      return status.peak ? 'peak' : 'off'
    }

    /** Poll the Host route; `sessionId` scopes the per-session pause/running fields. */
    function useStatus(sessionId, intervalMs) {
      const [status, setStatus] = useState(null)
      useEffect(() => {
        let alive = true
        const url = sessionId
          ? `${STATUS_URL}?session=${encodeURIComponent(sessionId)}`
          : STATUS_URL
        const load = () => {
          fetch(url, { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then((value) => {
              if (alive && value && value.ok) setStatus(value)
            })
            .catch(() => {})
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId, intervalMs])
      return status
    }

    /** Re-render on a wall-clock interval. */
    function useTicker(intervalMs) {
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs)
        return () => clearInterval(timer)
      }, [intervalMs])
      return now
    }

    const dotStyle = (phase) => ({
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      background: phase === 'peak' ? color.peak : color.off,
      flex: '0 0 auto',
    })

    const separator = (key) => h('span', {
      key,
      style: { color: color.borderStrong, userSelect: 'none' },
      'aria-hidden': true,
    }, '·')

    const rowStyle = { display: 'flex', alignItems: 'baseline', gap: '12px', fontSize: '20px', lineHeight: 1.5 }
    const popoverRowStyle = { ...rowStyle, fontSize: '18px' }

    /** One detail row; the hover popover uses a slightly smaller variant. */
    const buildRow = (style) => (label, value, key) => h('div', { key, style }, [
      h('span', {
        key: 'label',
        style: { color: color.secondary, flex: '0 0 112px' },
      }, label),
      h('span', {
        key: 'value',
        style: { color: color.primary, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
      }, value),
    ])

    const row = buildRow(rowStyle)
    const popoverRow = buildRow(popoverRowStyle)

    function sectionTitle(text, key) {
      return h('div', {
        key,
        style: {
          marginTop: '4px',
          paddingTop: '12px',
          borderTop: `1px solid ${color.border}`,
          fontSize: '14px',
          letterSpacing: '0.04em',
          color: color.secondary,
        },
      }, text)
    }

    /** Shared popover surface for the hover card and the detail panel. */
    const cardStyle = {
      background: color.overlay,
      border: `1px solid ${color.borderStrong}`,
      borderRadius: '12px',
      boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
      color: color.primary,
      font: 'inherit',
      padding: '16px 18px',
      pointerEvents: 'auto',
      boxSizing: 'border-box',
    }

    function useDetail(sessionId) {
      const [open, setOpen] = useState(false)
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)

      const load = () => {
        setLoading(true)
        setError('')
        const base = sessionId ? `${STATUS_URL}?session=${encodeURIComponent(sessionId)}&detail=1` : `${STATUS_URL}?detail=1`
        fetch(base, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((value) => {
            if (value && value.ok) setDetail(value)
            else setError('无法读取详情')
          })
          .catch(() => setError('无法读取详情'))
          .finally(() => setLoading(false))
      }

      const openPanel = () => {
        setOpen(true)
        load()
      }

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      return { open, detail, error, loading, openPanel, close: () => setOpen(false), reload: load }
    }

    function DetailPanel({ detail, error, loading, onClose, onReload, now }) {
      const balance = detail && detail.balance
      const usage = detail && detail.usage
      const peak = detail ? (detail.peak ? 'peak' : 'off') : null

      const balanceRows = []
      if (!balance) {
        balanceRows.push(row('状态', loading ? '读取中…' : '—', 'state'))
      } else if (balance.status === 'ready') {
        const wallets = Array.isArray(balance.wallets) ? balance.wallets : []
        const bonus = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
        if (wallets.length === 0) {
          balanceRows.push(row('充值余额', '0.00', 'wallets-empty'))
        }
        for (const wallet of wallets) {
          balanceRows.push(row('充值余额', `${symbolOf(wallet.currency)}${formatAmount(wallet.balance)}（${wallet.currency}）`, `w-${wallet.currency}`))
        }
        for (const wallet of bonus) {
          balanceRows.push(row('赠金余额', `${symbolOf(wallet.currency)}${formatAmount(wallet.balance)}（${wallet.currency}）`, `b-${wallet.currency}`))
        }
        const totals = new Map()
        for (const wallet of [...wallets, ...bonus]) {
          const value = Number(wallet.balance)
          if (!Number.isFinite(value)) continue
          totals.set(wallet.currency, (totals.get(wallet.currency) || 0) + value)
        }
        for (const [currency, value] of totals) {
          balanceRows.push(row('合计', `${symbolOf(currency)}${value.toFixed(2)}`, `t-${currency}`))
        }
        if (wallets.length > 0 || bonus.length > 0) {
          balanceRows.push(row('更新时间', detail.balanceAt ? formatClock(detail.balanceAt) : '—', 'at'))
        }
      } else if (balance.status === 'unavailable') {
        balanceRows.push(row('状态', balance.reason === 'signed-out' ? '未登录 DeepSeek 账号' : '当前配置未提供账号服务', 'state'))
      } else {
        balanceRows.push(row('状态', `读取失败（${balance.reason || '未知原因'}）`, 'state'))
      }

      const usageRows = []
      if (!usage) {
        usageRows.push(row('状态', loading ? '读取中…' : '—', 'state'))
      } else if (!usage.available) {
        usageRows.push(row('状态', '该会话不在当前进程中（未打开或已归档），无法读取用量', 'state'))
      } else {
        usageRows.push(row('输入', num(usage.inputTokens), 'in'))
        usageRows.push(row('缓存命中', num(usage.cacheReadTokens), 'hit'))
        usageRows.push(row('输出', num(usage.outputTokens), 'out'))
        usageRows.push(row('其中推理', num(usage.reasoningTokens), 'reason'))
        usageRows.push(row('合计', `${num(usage.totalTokens)}（输入+命中+输出）`, 'total'))
        usageRows.push(row('费用', `${formatCost(usage.costCNY)}（峰 ${formatCost(usage.costPeakCNY)} + 谷 ${formatCost(usage.costOffCNY)}）`, 'cost'))
        usageRows.push(row('计价', usage.pricedAs ? `${usage.pricedAs} 官价 · 按每条请求发生时段计价` : '—', 'priced'))
        usageRows.push(row('请求 / 工具', `${num(usage.requests)} 次 / ${num(usage.toolCalls)} 次`, 'calls'))
        usageRows.push(row('轮次 / 步骤', `${num(usage.turns)} / ${num(usage.steps)}`, 'turns'))
        usageRows.push(row('模型', usage.model ? `${usage.provider ? `${usage.provider}/` : ''}${usage.model}` : '—', 'model'))
      }

      const headRows = []
      if (detail) {
        headRows.push(row('当前相位', peak === 'peak' ? '峰价（谷价的 2 倍）' : '谷价（峰价的 5 折）', 'phase'))
        headRows.push(row('下次切换', `${switchLabel(detail.nextSwitchAt, now)} → ${detail.nextPhase === 'peak' ? '峰价' : '谷价'}`, 'next'))
        headRows.push(row('当前时间', formatClock(now), 'clock'))
        if (detail.holidayCovered === false) {
          const years = Array.isArray(detail.holidayYears) ? detail.holidayYears.join('、') : '—'
          headRows.push(row('假期表', `未覆盖当前年份（已收录 ${years} 年，其余按工作日计）`, 'holiday'))
        }
      }

      const closeButton = h('button', {
        key: 'close',
        type: 'button',
        onClick: onClose,
        'aria-label': '关闭',
        style: {
          marginLeft: 'auto',
          border: 'none',
          background: 'transparent',
          color: color.secondary,
          font: 'inherit',
          fontSize: '22px',
          lineHeight: 1,
          cursor: 'pointer',
          padding: '2px 6px',
        },
      }, '×')

      return h('div', {
        key: 'backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onClose()
        },
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 90,
          background: 'rgba(0, 0, 0, 0.28)',
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: '72px',
        },
      }, h('div', {
        style: { ...cardStyle, width: 'min(600px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          h('span', { key: 'title', style: { fontSize: '20px', fontWeight: 600 } }, '峰谷价 · 余额与用量'),
          closeButton,
        ]),
        ...headRows,
        sectionTitle('账户余额', 'sec-balance'),
        ...balanceRows,
        sectionTitle('本会话 Token', 'sec-usage'),
        ...usageRows,
        h('div', {
          key: 'foot',
          style: { marginTop: '12px', fontSize: '13px', color: color.secondary },
        }, error || (loading ? '正在读取…' : '双击胶囊打开此面板 · Esc 关闭 · 余额 60 秒缓存')),
        error ? h('button', {
          key: 'retry',
          type: 'button',
          onClick: onReload,
          style: {
            marginTop: '8px',
            alignSelf: 'flex-start',
            border: `1px solid ${color.border}`,
            background: 'transparent',
            color: color.secondary,
            font: 'inherit',
            fontSize: '14px',
            padding: '5px 12px',
            borderRadius: '999px',
            cursor: 'pointer',
          },
        }, '重试') : null,
      ]))
    }

    function PeakStatus(props) {
      const sessionId = props && props.sessionId
      const status = useStatus(sessionId, 10000)
      const now = useTicker(1000)
      const phase = phaseOf(status)
      const peak = phase === 'peak'
      const paused = !!(status && Array.isArray(status.paused)
        && status.paused.some((entry) => !sessionId || entry.id === sessionId))

      const countdown = status && typeof status.nextSwitchAt === 'number'
        ? formatCountdown(status.nextSwitchAt - now)
        : '—'

      const [hovering, setHovering] = useState(false)
      const anchorRef = useRef(null)
      const detail = useDetail(sessionId)

      const balanceText = walletLabel(status && status.balance)
      const costText = status && status.usage && status.usage.available
        ? formatCost(status.usage.costCNY)
        : '--'
      const shortCountdown = status && typeof status.nextSwitchAt === 'number'
        ? compactCountdown(status.nextSwitchAt - now)
        : '—'

      const pillChildren = [
        h('span', { key: 'dot', style: dotStyle(phase), 'aria-hidden': true }),
        h('span', {
          key: 'phase',
          style: { color: peak ? color.peak : color.off, fontWeight: 600 },
        }, peak ? '峰价' : '谷价'),
        separator('sep-1'),
        h('span', { key: 'clock', style: { fontVariantNumeric: 'tabular-nums' } }, formatClock(now)),
        separator('sep-2'),
        h('span', { key: 'countdown', style: { fontVariantNumeric: 'tabular-nums' } },
          `距${peak ? '谷价' : '峰价'} ${shortCountdown}`),
        separator('sep-3'),
        h('span', { key: 'balance', style: { fontVariantNumeric: 'tabular-nums' } }, `余额 ${balanceText}`),
        separator('sep-4'),
        h('span', { key: 'cost', style: { fontVariantNumeric: 'tabular-nums' } }, `会话 ${costText}`),
      ]
      if (paused) {
        pillChildren.push(separator('sep-5'), h('span', {
          key: 'paused',
          style: { color: color.secondary },
        }, '已暂停'))
      }

      const pill = h('div', {
        key: 'pill',
        ref: function assign(node) { anchorRef.current = node },
        role: 'button',
        tabIndex: 0,
        'aria-label': '峰谷价状态，双击查看余额与 Token 用量',
        onMouseEnter: (event) => {
          anchorRef.current = event.currentTarget
          setHovering(true)
        },
        onMouseLeave: () => setHovering(false),
        onFocus: (event) => {
          anchorRef.current = event.currentTarget
          setHovering(true)
        },
        onBlur: () => setHovering(false),
        onDoubleClick: detail.openPanel,
        onKeyDown: (event) => {
          if (event.key === 'Enter') detail.openPanel()
        },
        style: {
          // Stays in the header's own row: a window-anchored pill would land in
          // the desktop drag strip, where no pointer event reaches it and
          // double-click maximizes the window instead.
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          height: '32px',
          padding: '0 14px',
          borderRadius: '999px',
          border: `1px solid ${color.border}`,
          background: color.surface,
          color: color.secondary,
          font: 'inherit',
          fontSize: '14px',
          lineHeight: 1,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          cursor: 'default',
        },
      }, pillChildren)

      const nodes = [pill]

      if (hovering && !detail.open && status) {
        const rect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null
        if (rect) {
          const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16)
          const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))
          const rows = [
            popoverRow('当前相位', peak ? '峰价 · 谷价的 2 倍' : '谷价 · 峰价的 5 折', 'h-phase'),
            popoverRow('下次切换', `${switchLabel(status.nextSwitchAt, now)} → ${status.nextPhase === 'peak' ? '峰价' : '谷价'}（还剩 ${countdown}）`, 'h-next'),
          ]
          if (status.balance && status.balance.status === 'ready') {
            const wallets = Array.isArray(status.balance.wallets) ? status.balance.wallets : []
            const bonus = Array.isArray(status.balance.bonusWallets) ? status.balance.bonusWallets : []
            const parts = wallets.map((wallet) => `${wallet.currency} ${formatAmount(wallet.balance)}`)
            const bonusParts = bonus.map((wallet) => `${wallet.currency} ${formatAmount(wallet.balance)}`)
            rows.push(popoverRow('账户余额', parts.length ? parts.join(' · ') : '—', 'h-bal'))
            if (bonusParts.length) rows.push(popoverRow('赠金', bonusParts.join(' · '), 'h-bonus'))
          } else {
            rows.push(popoverRow('账户余额', balanceText, 'h-bal'))
          }
          if (status.usage && status.usage.available) {
            rows.push(popoverRow('本会话费用', `${formatCost(status.usage.costCNY)}（峰 ${formatCost(status.usage.costPeakCNY)} + 谷 ${formatCost(status.usage.costOffCNY)}）`, 'h-cost'))
          }
          if (paused) rows.push(popoverRow('会话', '已按「暂停」进入收尾', 'h-paused'))
          nodes.push(h('div', {
            key: 'popover',
            style: {
              ...cardStyle,
              position: 'fixed',
              top: `${Math.round(rect.bottom + 8)}px`,
              left: `${Math.round(left)}px`,
              width: `${Math.round(width)}px`,
              zIndex: 80,
            },
          }, [
            ...rows,
            h('div', {
              key: 'hint',
              style: { marginTop: '10px', fontSize: '13px', color: color.secondary },
            }, '双击胶囊查看余额明细与本会话 Token 用量'),
          ]))
        }
      }

      if (detail.open) {
        nodes.push(h(DetailPanel, {
          key: 'detail',
          detail: detail.detail,
          error: detail.error,
          loading: detail.loading,
          onClose: detail.close,
          onReload: detail.reload,
          now,
        }))
      }

      return h(React.Fragment, null, nodes)
    }

    function WrapUpReminder() {
      const status = useStatus(null, 5000)
      const [visible, setVisible] = useState(false)
      const [copied, setCopied] = useState(false)
      const shownRef = useRef('')

      const paused = !!(status && Array.isArray(status.paused) && status.paused.length > 0)
      const peak = !!(status && status.peak)
      const active = peak && !!status.running && !paused
      // The upcoming switch identifies one peak block (09:00-12:00 / 14:00-18:00),
      // so the reminder is raised at most once per block and remembered across
      // page reloads instead of popping up again on every turn.
      const blockKey = status && typeof status.nextSwitchAt === 'number' ? String(status.nextSwitchAt) : ''

      useEffect(() => {
        if (!active || !blockKey || shownRef.current === blockKey) return
        shownRef.current = blockKey
        if (hasReminded(blockKey)) return
        setCopied(false)
        setVisible(true)
      }, [active, blockKey])

      // The block ended: never leave a "peak now" card on screen.
      useEffect(() => {
        if (!peak) setVisible(false)
      }, [peak])

      if (!visible) return null

      const dismiss = () => {
        setVisible(false)
        if (blockKey) markReminded(blockKey)
      }

      const copyPause = () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText('暂停').then(() => setCopied(true)).catch(() => setCopied(false))
          }
        } catch {
          setCopied(false)
        }
      }

      const buttonStyle = {
        border: `1px solid ${color.border}`,
        background: 'transparent',
        color: color.secondary,
        font: 'inherit',
        fontSize: '14px',
        lineHeight: 1,
        padding: '8px 16px',
        borderRadius: '999px',
        cursor: 'pointer',
      }

      return h('div', {
        role: 'status',
        style: {
          position: 'fixed',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(640px, calc(100vw - 48px))',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          background: color.overlay,
          border: `1px solid ${color.borderStrong}`,
          borderRadius: '16px',
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.22)',
          padding: '20px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          font: 'inherit',
          fontSize: '20px',
          color: color.primary,
          lineHeight: 1.55,
          zIndex: 85,
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
        }, [
          h('span', { key: 'title', style: { fontSize: '20px', fontWeight: 600 } }, '高峰时段提醒'),
          h('span', {
            key: 'badge',
            style: { marginLeft: 'auto', color: color.peak, fontSize: '15px' },
          }, '谷价时段自动收起'),
        ]),
        h('div', { key: 'body', style: { color: color.secondary, fontSize: '20px' } }, [
          '当前为高峰时段（约谷价 2 倍）。回复',
          h('strong', { key: 'pause-word', style: { color: color.primary, padding: '0 3px' } }, '暂停'),
          '可优雅收尾：我会先写一份交接文档并暂停会话，等便宜时段再继续；不回复则照常推进。',
        ]),
        h('div', {
          key: 'actions',
          style: { display: 'flex', alignItems: 'center', gap: '10px' },
        }, [
          h('span', { key: 'hint', style: { fontSize: '13px', color: color.secondary } },
            copied ? '已复制，请粘贴到输入框并回车' : '在下方输入框回复「暂停」即可'),
          h('span', { key: 'spacer', style: { marginLeft: 'auto' } }),
          h('button', {
            key: 'copy',
            type: 'button',
            onClick: copyPause,
            style: { ...buttonStyle, pointerEvents: 'auto' },
          }, copied ? '已复制' : '复制「暂停」'),
          h('button', {
            key: 'confirm',
            type: 'button',
            onClick: dismiss,
            style: { ...buttonStyle, color: color.primary, borderColor: color.borderStrong },
          }, '知道了'),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'peak-status',
          order: 1,
          label: '峰谷价状态',
        }, PeakStatus))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'peak-status-reminder',
          order: 20,
        }, WrapUpReminder))
      },
    }
  },
})
