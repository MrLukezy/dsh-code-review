/**
 * dsh-code-review — 代码修改审查插件（浏览器半区）。
 *
 * 两个 slot：
 *   - `sidebar.footer.action`：侧边栏底部的“版本审查”入口。
 *   - `shell.overlay`：版本对比窗口本体（模态浮层）。
 *
 * 数据全部来自 Host 半区的 `POST /api/code-review`；本文件不读 DOM、不引宿主
 * Client 包，只用 React 与宿主主题 token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-code-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo, useReducer, useCallback } = React

    /** 语言命名空间（带包前缀，避免和宿主/其它插件撞名）。 */
    const NS = 'dshCodeReview'
    /** 记住上次选的仓库，下次打开直接回到那里。 */
    const MEMORY_KEY = 'dsh-code-review.repo'

    // =====================================================================
    // 基础工具
    // =====================================================================

    /** 拼接 className。 */
    function cx() {
      return Array.prototype.filter.call(arguments, Boolean).join(' ')
    }

    /** 取文案并做 `{name}` 占位替换（不依赖宿主 t 的参数能力）。 */
    function tt(t, key, vars) {
      let text
      try {
        text = t(key)
      } catch (error) {
        text = key
      }
      if (typeof text !== 'string' || text === '') text = key
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
      }
      return text
    }

    /** 路径末段。 */
    function baseName(file) {
      const parts = String(file || '').split('/')
      return parts[parts.length - 1] || file
    }

    /** 路径目录部分。 */
    function dirName(file) {
      const parts = String(file || '').split('/')
      parts.pop()
      return parts.join('/')
    }

    /** 相对时间（够用即可，不做本地化精度）。 */
    function relativeTime(iso, t) {
      if (!iso) return ''
      const value = Date.parse(iso)
      if (!Number.isFinite(value)) return ''
      const delta = Math.max(0, Date.now() - value)
      const minutes = Math.floor(delta / 60000)
      if (minutes < 1) return tt(t, 'justNow')
      if (minutes < 60) return tt(t, 'minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return tt(t, 'hoursAgo', { n: hours })
      const days = Math.floor(hours / 24)
      if (days < 30) return tt(t, 'daysAgo', { n: days })
      return new Date(value).toISOString().slice(0, 10)
    }

    /** 绝对时间。 */
    function absoluteTime(iso) {
      const value = Date.parse(iso)
      if (!Number.isFinite(value)) return ''
      const date = new Date(value)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /** 行号数组压成连续区间。 */
    function compressRanges(numbers) {
      const sorted = Array.from(new Set(numbers.filter((n) => Number.isFinite(n) && n > 0))).sort((a, b) => a - b)
      const ranges = []
      for (const value of sorted) {
        const last = ranges[ranges.length - 1]
        if (last && value === last[1] + 1) last[1] = value
        else ranges.push([value, value])
      }
      return ranges
    }

    /** 状态字母与配色。 */
    function statusMeta(entry) {
      if (!entry) return { letter: 'M', tone: 'mod' }
      if (entry.untracked) return { letter: 'U', tone: 'new' }
      const x = entry.x || ' '
      const y = entry.y || ' '
      if (x === 'D' || y === 'D') return { letter: 'D', tone: 'del' }
      if (x === 'A') return { letter: 'A', tone: 'new' }
      if (x === 'R' || y === 'R') return { letter: 'R', tone: 'mod' }
      if (x === 'C') return { letter: 'C', tone: 'mod' }
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A')) return { letter: '!', tone: 'conflict' }
      return { letter: 'M', tone: 'mod' }
    }

    /** 代码文件排前面，二进制文件沉到最后：否则一打开就点到 .bytes，看不出改了什么。 */
    const CODE_FILE = /\.(cs|java|kt|ts|tsx|js|jsx|mjs|cjs|py|lua|go|rs|c|cc|cpp|h|hpp|shader|compute|json|xml|yml|yaml|proto|sql|md|txt|prefab|asset)$/i

    function changeRank(entry) {
      if (entry.binary) return 3
      if (entry.untracked) return 1
      return CODE_FILE.test(entry.path) ? 0 : 2
    }

    function sortChanges(changes) {
      return changes
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => changeRank(a.entry) - changeRank(b.entry) || a.index - b.index)
        .map((item) => item.entry)
    }

    /** 简单线性图标。 */
    function icon(name, size) {
      const common = {
        width: size || 16,
        height: size || 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      if (name === 'review') {
        return h('svg', common,
          h('circle', { cx: 6, cy: 5, r: 2.1 }),
          h('circle', { cx: 6, cy: 19, r: 2.1 }),
          h('circle', { cx: 18, cy: 8, r: 2.1 }),
          h('path', { d: 'M6 7.1v9.8' }),
          h('path', { d: 'M18 10.1c0 3.1-3.1 3.5-5.9 4' }),
        )
      }
      if (name === 'close') {
        return h('svg', common, h('path', { d: 'M6 6l12 12' }), h('path', { d: 'M18 6L6 18' }))
      }
      if (name === 'refresh') {
        return h('svg', common,
          h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.1' }),
          h('path', { d: 'M20 4.5V11h-6.2' }),
        )
      }
      if (name === 'graph') {
        return h('svg', common,
          h('circle', { cx: 5, cy: 12, r: 2 }),
          h('circle', { cx: 19, cy: 6, r: 2 }),
          h('circle', { cx: 19, cy: 18, r: 2 }),
          h('path', { d: 'M7 11l10-4' }),
          h('path', { d: 'M7 13l10 4' }),
        )
      }
      if (name === 'chevron') {
        return h('svg', common, h('path', { d: 'M9 6l6 6-6 6' }))
      }
      if (name === 'check') {
        return h('svg', common, h('path', { d: 'M4.5 12.5l4.7 4.7L19.5 6.9' }))
      }
      if (name === 'spark') {
        return h('svg', common,
          h('path', { d: 'M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z' }),
          h('path', { d: 'M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z' }),
        )
      }
      return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8 }))
    }

    // =====================================================================
    // 状态仓库（两个 slot 共享同一份模块级状态）
    // =====================================================================

    const LAYOUT_KEY = 'dsh-code-review:layout'
    const LAYOUT_DEFAULT = { leftWidth: 280, rightWidth: 0, splitRatio: 0.5 }

    function clampNumber(value, min, max, fallback) {
      const number = Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, number))
    }

    function loadLayout() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(LAYOUT_KEY) || '{}')
        return {
          leftWidth: clampNumber(parsed.leftWidth, 200, 640, LAYOUT_DEFAULT.leftWidth),
          rightWidth: clampNumber(parsed.rightWidth, 0, 1000, LAYOUT_DEFAULT.rightWidth),
          splitRatio: clampNumber(parsed.splitRatio, 0.15, 0.85, LAYOUT_DEFAULT.splitRatio),
        }
      } catch (error) {
        return Object.assign({}, LAYOUT_DEFAULT)
      }
    }

    function persistLayout(patch) {
      try {
        const next = Object.assign({}, loadLayout(), patch)
        window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
      } catch (error) {
        /* 存不了就只在本次会话生效 */
      }
    }

    /** 更新布局：立刻生效，并写入 localStorage。 */
    function setLayout(patch) {
      persistLayout(patch)
      set(patch)
    }

    const initialLayout = loadLayout()

    const state = {
      open: false,
      root: '',
      repos: [],
      repoError: '',
      cwd: '',
      overview: null,
      busy: '',
      error: '',
      tab: 'changes',
      selection: null,
      diff: null,
      diffError: '',
      commit: null,
      annotations: { source: '', entries: [] },
      annotationError: '',
      blame: {},
      analyze: {},
      sideTab: 'notes',
      graphReady: false,
      graphBusy: false,
      reviews: {},
      reviewMode: 'file',
      models: null,
      modelChoice: '',
      hunkReviews: {},
      autoHunkReview: true,
      history: { path: '', commits: [], busy: false },
      /** 已审阅的文件：{ 仓库路径: [文件路径, ...] }，只影响左侧列表的显示，不影响能否查看。 */
      reviewed: loadReviewed(),
      hideReviewed: loadHideReviewed(),
      /** 布局：左右两栏宽度（rightWidth 为 0 时按页签自动）与差异视图左右分栏比例。 */
      leftWidth: initialLayout.leftWidth,
      rightWidth: initialLayout.rightWidth,
      splitRatio: initialLayout.splitRatio,
    }

    // =====================================================================
    // 审阅标记的本地持久化
    // =====================================================================

    const REVIEWED_KEY = 'dsh-code-review:reviewed'
    const HIDE_REVIEWED_KEY = 'dsh-code-review:hide-reviewed'

    function loadReviewed() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(REVIEWED_KEY) || '{}')
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch (error) {
        return {}
      }
    }

    function loadHideReviewed() {
      try {
        return window.localStorage.getItem(HIDE_REVIEWED_KEY) === '1'
      } catch (error) {
        return false
      }
    }

    function persistReviewed(value) {
      try {
        window.localStorage.setItem(REVIEWED_KEY, JSON.stringify(value))
      } catch (error) {
        /* 存不了就只在本次会话生效 */
      }
    }

    function persistHideReviewed(value) {
      try {
        window.localStorage.setItem(HIDE_REVIEWED_KEY, value ? '1' : '0')
      } catch (error) {
        /* 同上 */
      }
    }

    /** 某个仓库下已审阅的文件路径集合。 */
    function reviewedSet(repo) {
      const bucket = state.reviewed[repo || '']
      return Array.isArray(bucket) ? bucket : []
    }

    function isReviewed(path) {
      return reviewedSet(state.cwd).indexOf(path) >= 0
    }

    /** 切换一个文件的审阅状态；只是标记，不删除任何数据。 */
    function toggleReviewed(path) {
      const repo = state.cwd || ''
      const current = reviewedSet(repo)
      const next = current.indexOf(path) >= 0 ? current.filter((item) => item !== path) : current.concat([path])
      const reviewed = Object.assign({}, state.reviewed, { [repo]: next })
      persistReviewed(reviewed)
      set({ reviewed: reviewed })
    }

    function setHideReviewed(value) {
      persistHideReviewed(value)
      set({ hideReviewed: value })
    }

    const listeners = new Set()

    /** 通知所有订阅者。 */
    function emit() {
      for (const listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-code-review] listener failed', error)
        }
      }
    }

    /** 合并式更新。 */
    function set(patch) {
      Object.assign(state, patch)
      emit()
    }

    /** 订阅 store 的 hook。 */
    function useStore() {
      const [, bump] = useReducer((value) => value + 1, 0)
      useEffect(() => {
        listeners.add(bump)
        return () => {
          listeners.delete(bump)
        }
      }, [])
      return state
    }

    function readMemory() {
      try {
        return window.localStorage.getItem(MEMORY_KEY) || ''
      } catch (error) {
        return ''
      }
    }

    function writeMemory(value) {
      try {
        window.localStorage.setItem(MEMORY_KEY, value)
      } catch (error) {
        /* 隐私模式下忽略 */
      }
    }

    // =====================================================================
    // Host RPC
    // =====================================================================

    async function rpc(op, payload) {
      const response = await fetch('/api/code-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ op: op }, payload || {})),
      })
      const text = await response.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch (error) {
        data = null
      }
      if (!response.ok || (data && data.error)) {
        const message = data && data.error ? data.error.message : text ? text.slice(0, 300) : 'HTTP ' + response.status
        throw new Error(message)
      }
      return data || {}
    }

    // =====================================================================
    // 动作
    // =====================================================================

    function openWindow() {
      set({ open: true, error: '' })
      if (!state.repos.length) loadRepos()
    }

    function closeWindow() {
      set({ open: false })
    }

    async function loadRepos(rootOverride) {
      const explicit = typeof rootOverride === 'string' && rootOverride.trim() !== '' ? rootOverride.trim() : ''
      set({ busy: 'repos', error: '', repoError: '' })
      try {
        const data = await rpc('repos', explicit ? { root: explicit } : {})
        const repos = Array.isArray(data.repos) ? data.repos : []
        let cwd = state.cwd
        if (!cwd || !repos.some((repo) => repo.path === cwd)) {
          const remembered = readMemory()
          cwd = repos.some((repo) => repo.path === remembered) ? remembered : repos[0] ? repos[0].path : ''
        }
        set({ repos: repos, root: data.root || '', busy: '' })
        if (cwd) await selectRepo(cwd)
        else set({ repoError: tt(boundT, 'noRepo') })
      } catch (error) {
        set({ busy: '', repoError: String(error.message || error) })
      }
    }

    async function selectRepo(cwd) {
      if (!cwd) return
      writeMemory(cwd)
      set({
        cwd: cwd,
        overview: null,
        selection: null,
        diff: null,
        commit: null,
        diffError: '',
        annotations: { source: '', entries: [] },
        annotationError: '',
        blame: {},
        analyze: {},
        graphReady: false,
        busy: 'overview',
        error: '',
        reviews: {},
        hunkReviews: {},
        history: { path: '', commits: [], busy: false },
      })
      try {
        const [overview, annotations] = await Promise.all([
          rpc('overview', { cwd: cwd }),
          rpc('annotations', { cwd: cwd }).catch(() => ({ source: '', entries: [] })),
        ])
        set({
          overview: overview,
          annotations: { source: annotations.source || '', entries: Array.isArray(annotations.entries) ? annotations.entries : [] },
          annotationError: annotations.error || '',
          busy: '',
        })
        // 默认选第一个“能看”的文件：二进制资源排在前面时直接打开会很空
        const entries = sortChanges(overview.status || [])
        const first = entries[0]
        if (first) await selectFile(first)
      } catch (error) {
        set({ busy: '', error: String(error.message || error) })
      }
    }

    async function refreshOverview() {
      if (!state.cwd) return
      set({ busy: 'overview', error: '' })
      try {
        const overview = await rpc('overview', { cwd: state.cwd })
        set({ overview: overview, busy: '' })
        const selection = state.selection
        if (selection && selection.kind === 'file') {
          const stillThere = (overview.status || []).find((entry) => entry.path === selection.path)
          if (stillThere) await selectFile(stillThere, { keepSideTab: true })
          else set({ selection: null, diff: null })
        }
      } catch (error) {
        set({ busy: '', error: String(error.message || error) })
      }
    }

    async function selectFile(entry, options) {
      const selection = { kind: 'file', path: entry.path, status: entry }
      set({
        selection: selection,
        tab: 'changes',
        diff: null,
        diffError: '',
        commit: null,
        graphReady: false,
        history: { path: entry.path, commits: [], busy: true },
        sideTab: options && options.keepSideTab ? state.sideTab : 'notes',
        busy: 'diff',
      })
      try {
        const data = await rpc('diff', { cwd: state.cwd, path: entry.path, mode: 'auto' })
        set({ diff: data, busy: '' })
        loadHunkReviews(entry.path, data)
      } catch (error) {
        set({ busy: '', diffError: String(error.message || error) })
      }
      loadHistory(entry.path)
    }

    /**
     * 为一整个文件的每一处改动生成“简短审查”，悬浮提示直接用。
     * 一次调用覆盖该文件所有 hunk，按 diff 指纹缓存，重复打开不再花 token。
     */
    async function loadHunkReviews(file, diff) {
      if (!state.autoHunkReview || !file || !diff) return
      const parsed = parseUnified(diff.text || '')
      if (!parsed.hunks.length) return
      const blocks = buildSplitView(parsed).blocks
      if (!blocks.length) return
      const stamp = diff.mode + '|' + blocks.map((block) => block.newStart + ':' + block.added.length + ':' + block.removed.length).join('|')
      const cached = state.hunkReviews[file]
      if (cached && cached.stamp === stamp) return

      set({ hunkReviews: { ...state.hunkReviews, [file]: { stamp: stamp, busy: true, reviews: {} } } })
      try {
        const data = await rpc('hunkReview', {
          cwd: state.cwd,
          path: file,
          hunks: blocks.slice(0, 8).map((block) => ({
            header: block.header,
            rows: block.rows.map((row) => ({ t: row.t, text: row.text })),
          })),
        })
        const reviews = {}
        for (const item of data.reviews || []) reviews[item.index] = item
        set({ hunkReviews: { ...state.hunkReviews, [file]: { stamp: stamp, busy: false, reviews: reviews } } })
      } catch (error) {
        set({
          hunkReviews: { ...state.hunkReviews, [file]: { stamp: stamp, busy: false, reviews: {}, error: String(error.message || error) } },
        })
      }
    }

    /** 拉单个文件的提交历史：审查面板的「历史」用。 */
    async function loadHistory(path) {
      try {
        const data = await rpc('history', { cwd: state.cwd, path: path, limit: 12 })
        if (state.selection && state.selection.path === path) {
          set({ history: { path: path, commits: data.commits || [], busy: false } })
        }
      } catch (error) {
        if (state.selection && state.selection.path === path) {
          set({ history: { path: path, commits: [], busy: false, error: String(error.message || error) } })
        }
      }
    }

    async function selectCommit(commit) {
      set({
        selection: { kind: 'commit', rev: commit.hash, commit: commit },
        tab: 'commits',
        commit: null,
        diff: null,
        diffError: '',
        graphReady: false,
        busy: 'commit',
      })
      try {
        const detail = await rpc('commit', { cwd: state.cwd, rev: commit.hash })
        set({ commit: detail, busy: '' })
      } catch (error) {
        set({ busy: '', diffError: String(error.message || error) })
      }
    }

    async function selectCommitFile(file) {
      const rev = state.selection && state.selection.rev
      if (!rev) return
      set({
        selection: { kind: 'commitFile', rev: rev, path: file.path, status: file },
        diff: null,
        diffError: '',
        busy: 'diff',
        graphReady: false,
      })
      try {
        const data = await rpc('diff', { cwd: state.cwd, path: file.path, mode: 'commit', rev: rev })
        set({ diff: data, busy: '' })
      } catch (error) {
        set({ busy: '', diffError: String(error.message || error) })
      }
    }

    function backToCommit() {
      const selection = state.selection
      if (!selection || selection.kind !== 'commitFile') return
      const commit = state.overview && (state.overview.commits || []).find((item) => item.hash === selection.rev)
      if (commit) selectCommit(commit)
    }

    /**
     * 把 unified diff 摊成左右对照的行。
     *
     * 每一处连续的 -/+ 算一个“改动块”（block）：鼠标悬浮和简评都以块为单位，
     * 而不是整个 hunk——hunk 里还夹着上下文行。
     */
    function buildSplitRows(hunk, offset, lastNewRef) {
      const rows = []
      const blocks = []
      const source = hunk.rows
      let index = 0
      while (index < source.length) {
        const row = source[index]
        if (row.t === ' ') {
          if (typeof row.newNumber === 'number') lastNewRef.value = row.newNumber
          rows.push({
            kind: 'ctx',
            block: -1,
            left: { no: row.oldNumber, text: row.text },
            right: { no: row.newNumber, text: row.text },
          })
          index += 1
          continue
        }

        const removed = []
        const added = []
        while (index < source.length && source[index].t === '-') {
          removed.push(source[index])
          index += 1
        }
        while (index < source.length && source[index].t === '+') {
          added.push(source[index])
          index += 1
        }

        const blockIndex = offset + blocks.length
        // 纯删除没有新行号，就用“上一条上下文的新行号 + 1”当位置
        const newStart = added.length ? added[0].newNumber : lastNewRef.value + 1
        if (added.length) lastNewRef.value = added[added.length - 1].newNumber

        blocks.push({
          header: hunk.header,
          heading: hunk.heading,
          newStart: newStart,
          newCount: added.length || removed.length,
          added: added.map((item) => item.newNumber),
          removed: removed.map((item) => item.oldNumber),
          rows: removed.concat(added),
          index: blockIndex,
          total: 0,
        })

        const count = Math.max(removed.length, added.length)
        for (let k = 0; k < count; k += 1) {
          const left = removed[k]
          const right = added[k]
          rows.push({
            kind: left && right ? 'mod' : left ? 'del' : 'add',
            block: blockIndex,
            left: left ? { no: left.oldNumber, text: left.text } : null,
            right: right ? { no: right.newNumber, text: right.text } : null,
          })
        }
      }
      return { rows: rows, blocks: blocks }
    }

    /** 整份 diff 的左右对照视图 + 全局改动块清单。 */
    function buildSplitView(parsed) {
      const blocks = []
      const lastNewRef = { value: 0 }
      const hunks = (parsed ? parsed.hunks : []).map((hunk) => {
        const result = buildSplitRows(hunk, blocks.length, lastNewRef)
        for (const block of result.blocks) blocks.push(block)
        return { hunk: hunk, rows: result.rows }
      })
      for (const block of blocks) block.total = blocks.length
      return { hunks: hunks, blocks: blocks }
    }

    // =====================================================================
    // 语法着色：按 IDEA / Rider 的观感，用主题语义色派生
    // =====================================================================

    /** 前端版本号，与 package.json 的 version 保持一致；窗口标题旁会显示，便于确认加载的是哪一版。 */
    const CLIENT_VERSION = '0.5.0'

    /** 把 CSS 颜色解析成 [r, g, b]。 */
    function parseCssColor(value) {
      const raw = String(value || '').trim()
      if (!raw) return null
      const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw)
      if (hex) {
        const body = hex[1]
        if (body.length === 3) {
          return [parseInt(body[0] + body[0], 16), parseInt(body[1] + body[1], 16), parseInt(body[2] + body[2], 16)]
        }
        return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)]
      }
      const rgb = /^rgba?\(([^)]+)\)$/i.exec(raw)
      if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number)
        if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(part))) return parts.slice(0, 3)
      }
      return null
    }

    /**
     * 判断当前是明主题还是暗主题。
     * 宿主没有暴露 mode，只能看 --dsw-alias-bg-base 的实际亮度。
     */
    function detectColorMode() {
      try {
        for (const node of [document.documentElement, document.body]) {
          if (!node) continue
          const style = getComputedStyle(node)
          const rgb = parseCssColor(style.getPropertyValue('--dsw-alias-bg-base'))
          if (rgb) {
            const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
            return luminance < 0.5 ? 'dark' : 'light'
          }
          const scheme = String(style.colorScheme || '').trim()
          if (scheme.includes('dark') && !scheme.includes('light')) return 'dark'
        }
      } catch (error) {
        /* 取不到就按明主题处理 */
      }
      return 'light'
    }

    /** 跟随宿主主题切换：两秒轮询一次，成本可以忽略。 */
    function useColorMode() {
      const [mode, setMode] = useState(detectColorMode)
      useEffect(() => {
        const timer = window.setInterval(() => {
          const next = detectColorMode()
          setMode((current) => (current === next ? current : next))
        }, 2000)
        return () => window.clearInterval(timer)
      }, [])
      return mode
    }

    /** C# 与 Java 的关键字并集：两者重合度很高，合并一套够用。 */
    const SYNTAX_KEYWORDS = new Set([
      'abstract', 'as', 'async', 'await', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
      'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate', 'delete', 'do',
      'double', 'dynamic', 'else', 'enum', 'event', 'explicit', 'export', 'extends', 'extern',
      'false', 'final', 'finally', 'fixed', 'float', 'for', 'foreach', 'function', 'get', 'global',
      'goto', 'if', 'implements', 'implicit', 'import', 'in', 'init', 'instanceof', 'int',
      'interface', 'internal', 'is', 'let', 'lock', 'long', 'namespace', 'native', 'new', 'null',
      'object', 'operator', 'out', 'override', 'package', 'params', 'partial', 'private',
      'protected', 'public', 'readonly', 'record', 'ref', 'return', 'sealed', 'set', 'short',
      'sizeof', 'stackalloc', 'static', 'string', 'struct', 'super', 'switch', 'synchronized',
      'this', 'throw', 'throws', 'transient', 'true', 'try', 'typeof', 'uint', 'ulong',
      'unchecked', 'unsafe', 'ushort', 'using', 'var', 'virtual', 'void', 'volatile', 'when',
      'where', 'while', 'yield',
    ])

    /**
     * 一行代码的 token 切分。
     * 注释/字符串优先，其次注解、预处理指令、数字、标识符。
     */
    const SYNTAX_TOKEN_RE = /(\/\/.*$|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|@[A-Za-z_]\w*|#[A-Za-z]+|\b\d+(?:\.\d+)?[fFdDlLmMuU]?\b|\b[A-Za-z_]\w*\b)/g

    /**
     * 字段 / 常量声明：`private long uid;` 里的 `uid` 要单独着色。
     * 必须以访问修饰符或 static/final/readonly 开头，避免把局部变量也染成字段色。
     */
    const FIELD_DECL_RE = /^\s*(?:(?:public|private|protected|internal|static|readonly|final|volatile|transient|const|abstract|sealed|unsafe)\s+)+([A-Za-z_][\w<>[\],.?\s]*?)\s+([A-Za-z_]\w*)\s*(?:=[^=]|;|,|$)/

    function classifyToken(token, nextChar, fieldName) {
      if (token.startsWith('//') || token.startsWith('/*')) return 'dcr-sy-cmt'
      if (token[0] === '"' || token[0] === "'") return 'dcr-sy-str'
      if (token[0] === '@' || token[0] === '#') return 'dcr-sy-ann'
      if (/^\d/.test(token)) return 'dcr-sy-num'
      if (SYNTAX_KEYWORDS.has(token)) return 'dcr-sy-kw'
      // 后面紧跟左括号的是方法调用，和类型名分开着色（关键字已先排除）
      if (nextChar === '(') return 'dcr-sy-fn'
      // 全大写标识符当常量
      if (/^[A-Z][A-Z0-9_]{1,}$/.test(token)) return 'dcr-sy-cst'
      // 声明行里被声明的那个名字当字段
      if (fieldName && token === fieldName) return 'dcr-sy-fld'
      // 首字母大写且不是全大写常量 → 当作类型名
      if (/^[A-Z]/.test(token) && !/^[A-Z0-9_]+$/.test(token)) return 'dcr-sy-typ'
      return ''
    }

    /** 逐行着色结果缓存：悬浮等状态变化会重渲染，避免重复切分。 */
    const syntaxCache = new Map()

    function highlightLine(text) {
      const source = String(text === undefined || text === null ? '' : text)
      const cached = syntaxCache.get(source)
      if (cached) return cached

      const tokens = []
      // 这一行如果是字段声明，记下被声明的名字，下面单独着色
      const fieldMatch = FIELD_DECL_RE.exec(source)
      const fieldName = fieldMatch ? fieldMatch[2] : ''

      // Javadoc / 块注释的续行：整行都是注释
      if (/^\s*(\/\*|\*)/.test(source)) {
        tokens.push({ text: source, cls: 'dcr-sy-cmt' })
      } else if (!source.trim()) {
        tokens.push({ text: source, cls: '' })
      } else {
        let last = 0
        SYNTAX_TOKEN_RE.lastIndex = 0
        let match = SYNTAX_TOKEN_RE.exec(source)
        while (match) {
          if (match.index > last) tokens.push({ text: source.slice(last, match.index), cls: '' })
          tokens.push({ text: match[0], cls: classifyToken(match[0], source[match.index + match[0].length], fieldName) })
          last = match.index + match[0].length
          match = SYNTAX_TOKEN_RE.exec(source)
        }
        if (last < source.length) tokens.push({ text: source.slice(last), cls: '' })
      }

      if (syntaxCache.size > 6000) syntaxCache.clear()
      syntaxCache.set(source, tokens)
      return tokens
    }

    /** 把一行代码渲染成着色后的 span 列表。 */
    function renderCode(text) {
      const tokens = highlightLine(text)
      if (tokens.length === 1 && !tokens[0].cls) return tokens[0].text
      return tokens.map((token, index) =>
        token.cls ? h('span', { key: index, className: token.cls }, token.text) : token.text,
      )
    }

    /** 单个 hunk 的缓存键。 */
    function hunkKey(file, hunk) {
      return file + '@' + hunk.newStart + ':' + hunk.added.length + ':' + hunk.removed.length + ':' + (hunk.index || 0)
    }

    /** 懒加载 hunk 的 blame 与符号扫描结果。 */
    function ensureHunkData(file, hunk, rev) {
      const key = hunkKey(file, hunk)
      const added = hunk.added
      if (!added.length) return
      if (!state.blame[key]) {
        state.blame[key] = { lines: [], loading: true }
        emit()
        rpc('blame', { cwd: state.cwd, path: file, start: added[0], end: added[added.length - 1] })
          .then((data) => {
            state.blame[key] = Object.assign({ loading: false }, data)
            emit()
          })
          .catch((error) => {
            state.blame[key] = { lines: [], loading: false, error: String(error.message || error) }
            emit()
          })
      }
      if (!state.analyze[key]) {
        state.analyze[key] = { symbols: [], loading: true }
        emit()
        rpc('analyze', { cwd: state.cwd, path: file, ranges: compressRanges(added), rev: rev || undefined })
          .then((data) => {
            state.analyze[key] = Object.assign({ loading: false }, data)
            emit()
          })
          .catch((error) => {
            state.analyze[key] = { symbols: [], loading: false, error: String(error.message || error) }
            emit()
          })
      }
    }

    /** 为关系图把整份文件的 hunk 都分析一遍（最多 5 段）。 */
    async function analyzeFileForGraph() {
      const selection = state.selection
      const diff = state.diff
      if (!selection || selection.kind === 'commit' || !diff) return
      set({ graphBusy: true })
      const parsed = parseUnified(diff.text)
      const hunks = parsed.hunks.filter((hunk) => hunk.added.length).slice(0, 5)
      for (const hunk of hunks) {
        const key = hunkKey(selection.path, hunk)
        if (state.analyze[key]) continue
        state.analyze[key] = { symbols: [], loading: true }
        emit()
        try {
          const data = await rpc('analyze', {
            cwd: state.cwd,
            path: selection.path,
            ranges: compressRanges(hunk.added),
            rev: selection.kind === 'commitFile' ? selection.rev : undefined,
          })
          state.analyze[key] = Object.assign({ loading: false }, data)
        } catch (error) {
          state.analyze[key] = { symbols: [], loading: false, error: String(error.message || error) }
        }
        emit()
      }
      set({ graphBusy: false, graphReady: true, sideTab: 'graph' })
    }

    /** 当前文件所有已加载的分析结果合并。 */
    function mergedSymbols(file) {
      const buckets = new Map()
      for (const key of Object.keys(state.analyze)) {
        if (!key.startsWith(file + '@')) continue
        const result = state.analyze[key]
        for (const symbol of result.symbols || []) {
          const existing = buckets.get(symbol.name)
          if (existing) {
            existing.defs = existing.defs.concat(symbol.defs || [])
            existing.refs = existing.refs.concat(symbol.refs || [])
            existing.total += symbol.total || 0
            existing.score = Math.max(existing.score || 0, symbol.score || 0)
          } else {
            buckets.set(symbol.name, {
              name: symbol.name,
              defs: (symbol.defs || []).slice(),
              refs: (symbol.refs || []).slice(),
              total: symbol.total || 0,
              score: symbol.score || 0,
            })
          }
        }
      }
      return Array.from(buckets.values()).sort((a, b) => (b.score || 0) - (a.score || 0))
    }

    /** 当前文件命中的标注条目。 */
    function fileAnnotation(file) {
      const entries = state.annotations.entries || []
      const normalized = String(file || '').replace(/\\/g, '/').toLowerCase()
      for (const entry of entries) {
        if (String(entry.file || '').replace(/\\/g, '/').toLowerCase() === normalized) return entry
      }
      return null
    }

    /** 某个 hunk 命中的标注条目（按行区间匹配）。 */
    function hunkAnnotation(file, hunk) {
      const entries = state.annotations.entries || []
      const normalized = String(file || '').replace(/\\/g, '/').toLowerCase()
      const low = hunk.newStart
      const high = hunk.newStart + Math.max(hunk.rows.length, 1)
      for (const entry of entries) {
        if (String(entry.file || '').replace(/\\/g, '/').toLowerCase() !== normalized) continue
        const range = Array.isArray(entry.lines) ? entry.lines : null
        if (!range || range.length < 2) return entry
        if (Number(range[0]) <= high && Number(range[1]) >= low) return entry
      }
      return null
    }

    // =====================================================================
    // 统一 diff 解析
    // =====================================================================

    function parseUnified(text) {
      const rows = String(text || '').split('\n')
      const head = []
      const hunks = []
      let current = null
      let oldNumber = 0
      let newNumber = 0
      for (const source of rows) {
        // CRLF 仓库里 diff 行会带行尾 \r，渲染与解析前先去掉
        const raw = source.endsWith('\r') ? source.slice(0, -1) : source
        if (raw.startsWith('@@')) {
          const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw)
          current = {
            header: raw,
            heading: match ? match[5].trim() : '',
            oldStart: match ? Number(match[1]) : 0,
            oldCount: match ? Number(match[2] || 1) : 0,
            newStart: match ? Number(match[3]) : 0,
            newCount: match ? Number(match[4] || 1) : 0,
            rows: [],
            added: [],
            removed: [],
          }
          oldNumber = current.oldStart
          newNumber = current.newStart
          hunks.push(current)
          continue
        }
        if (!current) {
          if (raw && !raw.startsWith('\\')) head.push(raw)
          continue
        }
        if (raw.startsWith('\\')) continue
        const tag = raw[0]
        const body = raw.slice(1)
        if (tag === '+') {
          current.rows.push({ t: '+', text: body, newNumber: newNumber })
          current.added.push(newNumber)
          newNumber += 1
        } else if (tag === '-') {
          current.rows.push({ t: '-', text: body, oldNumber: oldNumber })
          current.removed.push(oldNumber)
          oldNumber += 1
        } else if (tag === ' ' || raw === '') {
          current.rows.push({ t: ' ', text: body, oldNumber: oldNumber, newNumber: newNumber })
          oldNumber += 1
          newNumber += 1
        }
      }
      // 去掉尾部 split 产生的空行
      for (const hunk of hunks) {
        while (hunk.rows.length && hunk.rows[hunk.rows.length - 1].t === ' ' && hunk.rows[hunk.rows.length - 1].text === '') hunk.rows.pop()
      }
      return { head: head, hunks: hunks }
    }

    // =====================================================================
    // 悬浮提示内容：这一处改动在干什么
    // =====================================================================

    /** 提取“调用”时要排掉的语法关键字。 */
    const CALL_KEYWORDS = new Set([
      'if', 'for', 'foreach', 'while', 'switch', 'return', 'new', 'var', 'this', 'base',
      'catch', 'using', 'lock', 'typeof', 'nameof', 'await', 'async', 'get', 'set', 'value',
      'out', 'ref', 'is', 'as', 'null', 'true', 'false', 'sizeof', 'default', 'checked',
    ])

    function uniqueNames(names) {
      const seen = new Set()
      const out = []
      for (const name of names) {
        if (!name || CALL_KEYWORDS.has(name) || seen.has(name)) continue
        seen.add(name)
        out.push(name)
      }
      return out
    }

    /** 从若干行代码里抽出被调用的方法名。 */
    function extractCalls(lines) {
      const names = []
      for (const line of lines) {
        for (const match of String(line).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) names.push(match[1])
      }
      return uniqueNames(names)
    }

    /** 模型简评还没回来时，用规则把这一处改动讲清楚。 */
    function summarizeHunkRules(hunk) {
      const added = hunk.rows.filter((row) => row.t === '+').map((row) => row.text)
      const removed = hunk.rows.filter((row) => row.t === '-').map((row) => row.text)
      const items = []

      const addedCalls = extractCalls(added)
      const removedCalls = extractCalls(removed)
      const newCalls = addedCalls.filter((name) => !removedCalls.includes(name))
      const goneCalls = removedCalls.filter((name) => !addedCalls.includes(name))
      if (newCalls.length) items.push('新增调用 ' + newCalls.slice(0, 4).join('、'))
      if (goneCalls.length) items.push('移除调用 ' + goneCalls.slice(0, 4).join('、'))

      const isBranch = (line) => /^\s*(if|else\s+if|switch)\b/.test(line)
      const addedBranches = added.filter(isBranch).length
      const removedBranches = removed.filter(isBranch).length
      if (addedBranches) items.push('新增 ' + addedBranches + ' 处条件判断')
      if (removedBranches) items.push('删除 ' + removedBranches + ' 处条件判断')

      // 新增的字段 / 局部变量：只看赋值左边的名字
      const names = []
      for (const line of added) {
        const match = /^\s*(?:(?:public|private|protected|internal|static|readonly|const)\s+)*[A-Za-z_][\w<>[\],.? ]*\s+([A-Za-z_]\w*)\s*=[^=]/.exec(line)
        if (match) names.push(match[1])
      }
      if (names.length) items.push('新增变量 ' + uniqueNames(names).slice(0, 4).join('、'))

      const addedComments = added.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line)).length
      if (addedComments) items.push('补了 ' + addedComments + ' 行注释')

      if (!items.length) items.push('改了 ' + added.length + ' 行、删了 ' + removed.length + ' 行')
      return items
    }

    /** 规则层面的风险提醒：模型简评没回来之前先顶一下。 */
    function risksFromRules(hunk) {
      const added = hunk.rows.filter((row) => row.t === '+').map((row) => row.text)
      const removed = hunk.rows.filter((row) => row.t === '-').map((row) => row.text)
      const risks = []

      const removedBranches = removed.filter((line) => /^\s*(if|else\s+if|switch)\b/.test(line)).length
      if (removedBranches) risks.push('删掉了 ' + removedBranches + ' 处条件判断，确认空值和边界还要不要挡')
      if (added.some((line) => /^\s*public\s+/.test(line))) risks.push('新增了 public 成员，外部调用方可能受影响')
      if (added.some((line) => /\bnew\s+Cs[A-Za-z]/.test(line) || /\bSend[A-Za-z]*\(/.test(line))) {
        risks.push('涉及协议发送，确认字段来源和发送时机')
      }
      const hardcoded = []
      for (const line of added) {
        for (const match of String(line).matchAll(/(?<![\w.])(\d+(?:\.\d+)?f?)(?![\w.])/g)) {
          if (!/^[01]$/.test(match[1])) hardcoded.push(match[1])
        }
      }
      if (hardcoded.length) risks.push('新增硬编码数值 ' + Array.from(new Set(hardcoded)).slice(0, 4).join('、'))
      return risks
    }

    /**
     * 组装悬浮提示：审查范围 + 这段改了什么 + 风险 + 依据 + 相关定义。
     * 模型简评（info.review）优先，没回来时用规则兜底。
     */
    function buildTipSections(t, file, hunk, annotation, blame, analysis, extra) {
      const sections = []
      const info = extra || {}
      const index = typeof info.index === 'number' ? info.index : 0
      const total = typeof info.total === 'number' ? info.total : 1

      // ---- 审查范围：先讲清楚这一条覆盖哪些行 ----
      sections.push({
        key: 'scope',
        label: tt(t, 'tipScopeLabel'),
        items: [
          {
            kind: 'text',
            value: tt(t, 'tipScope', {
              start: hunk.newStart,
              end: hunk.newStart + Math.max(0, hunk.newCount - 1),
              added: hunk.added.length,
              removed: hunk.removed.length,
              index: index + 1,
              total: total,
            }),
          },
        ],
      })

      // ---- 这段改了什么 ----
      const what = []
      if (info.review && info.review.what) {
        what.push({ kind: 'text', value: String(info.review.what) })
      } else {
        if (info.busy) what.push({ kind: 'muted', value: tt(t, 'tipReviewPending') })
        for (const line of summarizeHunkRules(hunk)) what.push({ kind: 'text', value: line })
      }
      sections.push({ key: 'what', label: tt(t, 'tipWhat'), items: what })

      // ---- 风险 ----
      const risk = []
      if (info.review && info.review.risk) risk.push({ kind: 'warn', value: String(info.review.risk) })
      else for (const line of risksFromRules(hunk)) risk.push({ kind: 'warn', value: line })
      sections.push({
        key: 'risk',
        label: tt(t, 'tipRisk'),
        items: risk.length ? risk : [{ kind: 'muted', value: tt(t, 'tipNoRisk') }],
      })

      // ---- 依据 ----
      const basis = []
      if (annotation && annotation.basis) basis.push({ kind: 'text', value: String(annotation.basis) })
      if (blame && blame.loading) basis.push({ kind: 'muted', value: tt(t, 'loading') })
      if (blame && !blame.loading) {
        const lines = blame.lines || []
        if (blame.pending) {
          basis.push({ kind: 'muted', value: tt(t, 'pendingChange') })
          if (blame.fileCommit) {
            basis.push({
              kind: 'commit',
              label: tt(t, 'lastFileCommit'),
              short: blame.fileCommit.short,
              author: blame.fileCommit.author,
              date: blame.fileCommit.date,
              summary: blame.fileCommit.summary || tt(t, 'noMessage'),
            })
          }
        } else if (lines.length) {
          const newest = lines[lines.length - 1]
          basis.push({
            kind: 'commit',
            short: newest.short,
            author: newest.author,
            date: newest.date,
            summary: newest.summary || tt(t, 'noMessage'),
          })
        } else if (!annotation || !annotation.basis) {
          basis.push({ kind: 'muted', value: blame.error || tt(t, 'noBasis') })
        }
      }
      sections.push({
        key: 'basis',
        label: tt(t, 'tipBasis'),
        items: basis.length ? basis : [{ kind: 'muted', value: tt(t, 'noBasis') }],
      })

      // ---- 相关定义 + 绑定文件（各最多 2 条，避免又变成 grep 转储） ----
      const defs = []
      if (annotation && Array.isArray(annotation.references)) {
        for (const reference of annotation.references.slice(0, 2)) {
          defs.push({
            kind: 'code',
            path: reference.path,
            line: Array.isArray(reference.lines) ? reference.lines[0] : reference.line,
            note: reference.note || '',
            text: reference.code || '',
          })
        }
      }
      if (!defs.length && analysis && !analysis.loading) {
        for (const symbol of (analysis.symbols || []).slice(0, 2)) {
          const definition = (symbol.defs || []).find((item) => !item.target)
          if (!definition) continue
          defs.push({
            kind: 'code',
            path: definition.path,
            line: definition.line,
            note: tt(t, 'tipDefines', { name: symbol.name }),
            text: definition.text,
          })
        }
      }
      if (defs.length) sections.push({ key: 'defs', label: tt(t, 'tipDefs'), items: defs })

      if (analysis && !analysis.loading && !annotation) {
        const files = new Map()
        for (const symbol of (analysis.symbols || []).slice(0, 5)) {
          for (const item of (symbol.refs || []).concat(symbol.defs || [])) {
            if (item.target || item.path === file) continue
            files.set(item.path, (files.get(item.path) || 0) + 1)
          }
        }
        const top = Array.from(files.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3)
        if (top.length) {
          sections.push({
            key: 'bound',
            label: tt(t, 'tipBoundLabel'),
            items: [{ kind: 'muted', value: tt(t, 'tipBoundFiles', { n: top.length, files: top.map((entry) => baseName(entry[0])).join('、') }) }],
          })
        }
      }

      return sections
    }

    // =====================================================================
// 自然语言审查（SSE 流式）
// =====================================================================

/** 审查结果按「范围 + 文件」缓存，切来切去不会丢。 */
    function reviewKey(mode, file) {
      return mode === 'all' ? 'all' : 'file:' + file
    }

    /** 正在进行中的审查请求。 */
    let reviewAbort = null

    /** 宽松地解析模型返回的 JSON（允许代码围栏和前后废话）。 */
    function parseReviewJson(text) {
      let value = String(text || '').trim()
      if (!value) return null
      const fence = /^```(?:json)?\s*([\s\S]*?)```$/.exec(value)
      if (fence) value = fence[1].trim()
      const start = value.indexOf('{')
      if (start === -1) return null
      const end = value.lastIndexOf('}')
      const body = end > start ? value.slice(start, end + 1) : value.slice(start)
      try {
        return JSON.parse(body)
      } catch (error) {
        return repairReviewJson(body)
      }
    }

    /**
     * 输出被 token 上限截断时，尾部一定是不完整的。
     * 这里从尾部逐段回退并补齐括号，尽量把已经生成的部分救回来。
     */
    function repairReviewJson(raw) {
      let value = raw
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const closed = closeJsonFragment(value)
        if (closed) {
          try {
            return JSON.parse(closed)
          } catch (error) {
            /* 继续回退 */
          }
        }
        const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf('}'), value.lastIndexOf(']'))
        if (cut <= 0) return null
        value = value.slice(0, cut)
      }
      return null
    }

    /** 给残缺 JSON 补齐未闭合的字符串与括号，并丢掉悬空的逗号 / 冒号。 */
    function closeJsonFragment(raw) {
      let out = ''
      const stack = []
      let inString = false
      let escaped = false
      for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index]
        out += char
        if (inString) {
          if (escaped) escaped = false
          else if (char === '\\') escaped = true
          else if (char === '"') inString = false
          continue
        }
        if (char === '"') inString = true
        else if (char === '{') stack.push('}')
        else if (char === '[') stack.push(']')
        else if (char === '}' || char === ']') stack.pop()
      }
      if (inString) out += '"'
      out = out.replace(/[\s,]*$/, '')
      // 结尾若是 "key": 这种没有值的半截键，整段丢掉
      if (/:\s*$/.test(out)) out = out.replace(/,\s*"[^"]*"\s*:\s*$/, '')
      out = out.replace(/[,:]\s*$/, '')
      while (stack.length) out += stack.pop()
      return out
    }

    /** 拉一次可用模型目录（用于审查面板的模型下拉框）。 */
    async function loadModels() {
      if (state.models) return
      try {
        const data = await rpc('models')
        set({ models: data })
      } catch (error) {
        set({ models: { providers: [], error: String(error.message || error) } })
      }
    }

    function stopReview() {
      if (reviewAbort) {
        try {
          reviewAbort.abort()
        } catch (error) {
          /* 忽略 */
        }
        reviewAbort = null
      }
    }

    /** 发起一次审查：先 SSE 流式收字，结束后解析成结构化结果。 */
    async function startReview(mode) {
      const selection = state.selection
      const file = selection && selection.path ? selection.path : ''
      if (mode === 'file' && !file) return
      const key = reviewKey(mode, file)
      stopReview()
      const controller = new AbortController()
      reviewAbort = controller
      state.reviews[key] = { status: 'streaming', text: '', error: '', meta: null, parsed: null, mode: mode, path: file }
      emit()

      try {
        const body = { cwd: state.cwd, mode: mode }
        if (mode === 'file') body.path = file
        if (selection && selection.kind === 'commitFile' && selection.rev) body.rev = selection.rev
        if (state.modelChoice) {
          const parts = state.modelChoice.split('|')
          if (parts.length === 2) {
            body.provider = parts[0]
            body.model = parts[1]
          }
        }
        const response = await fetch('/api/code-review/review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          let message = 'HTTP ' + response.status
          try {
            const data = await response.json()
            message = (data && data.error && data.error.message) || message
          } catch (error) {
            /* 响应体不是 JSON */
          }
          throw new Error(message)
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const result = await reader.read()
          if (result.done) break
          buffer += decoder.decode(result.value, { stream: true })
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const entry = state.reviews[key]
            if (!entry) return
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (!dataLine) continue
            const eventLine = frame.split('\n').find((line) => line.startsWith('event: '))
            const event = eventLine ? eventLine.slice(7) : 'message'
            let data = null
            try {
              data = JSON.parse(dataLine.slice(6))
            } catch (error) {
              continue
            }
            if (event === 'start') {
              entry.meta = data
            } else if (event === 'delta') {
              entry.text += data.text || ''
            } else if (event === 'thinking') {
              entry.thinking = (entry.thinking || 0) + String(data.text || '').length
            } else if (event === 'error') {
              entry.error = data.message || tt(boundT, 'reviewFailed')
              entry.status = 'error'
            } else if (event === 'done') {
              entry.text = data.text || entry.text
              entry.truncated = Boolean(data.truncated)
              entry.parsed = parseReviewJson(entry.text)
              entry.status = 'done'
            }
            emit()
          }
        }
        const entry = state.reviews[key]
        if (entry && entry.status === 'streaming') {
          entry.parsed = parseReviewJson(entry.text)
          entry.status = entry.error ? 'error' : 'done'
          emit()
        }
      } catch (error) {
        const entry = state.reviews[key]
        if (controller.signal.aborted) {
          // 用户主动停止：保留已经收到的内容
          if (entry) {
            entry.parsed = parseReviewJson(entry.text)
            entry.status = 'done'
            entry.stopped = true
            emit()
          }
        } else if (entry) {
          entry.status = 'error'
          entry.error = String(error.message || error)
          emit()
        }
      } finally {
        if (reviewAbort === controller) reviewAbort = null
      }
    }

    // =====================================================================
    // 组件：拖拽分隔
    // =====================================================================

    /** 水平拖拽：按住后按每次位移回调，松开或失焦结束。 */
    function useHorizontalDrag(onDelta) {
      const [dragging, setDragging] = useState(false)
      const last = useRef(0)
      const handler = useRef(onDelta)
      handler.current = onDelta

      useEffect(() => {
        if (!dragging) return undefined
        const onMove = (event) => {
          const delta = event.clientX - last.current
          last.current = event.clientX
          if (delta) handler.current(delta)
        }
        const stop = () => setDragging(false)
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', stop)
        window.addEventListener('blur', stop)
        const previousCursor = document.body.style.cursor
        const previousSelect = document.body.style.userSelect
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        return () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', stop)
          window.removeEventListener('blur', stop)
          document.body.style.cursor = previousCursor
          document.body.style.userSelect = previousSelect
        }
      }, [dragging])

      return {
        dragging: dragging,
        start: (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          last.current = event.clientX
          setDragging(true)
        },
      }
    }

    /** 两栏之间的竖直分隔条。 */
    function Splitter(props) {
      const drag = useHorizontalDrag(props.onDelta)
      return h('div', {
        className: cx('dcr-splitter', drag.dragging && 'dcr-splitter-on'),
        role: 'separator',
        'aria-orientation': 'vertical',
        title: props.title,
        onMouseDown: drag.start,
        onDoubleClick: props.onReset,
      })
    }

    /** 差异视图中间的分栏手柄：拖动改变「基础版本 / 本地修改」的宽度比。 */
    function SplitGrip(props) {
      const ref = useRef(null)
      const widthRef = useRef(1)
      const drag = useHorizontalDrag((delta) => {
        props.onRatio(clampNumber(props.ratio + delta / (widthRef.current || 1), 0.15, 0.85, 0.5))
      })
      return h('div', {
        ref: ref,
        className: cx('dcr-grip', drag.dragging && 'dcr-grip-on'),
        role: 'separator',
        'aria-orientation': 'vertical',
        title: props.title,
        onMouseDown: (event) => {
          const parent = ref.current && ref.current.parentElement
          widthRef.current = parent ? parent.clientWidth : 1
          drag.start(event)
        },
        onDoubleClick: props.onReset,
      })
    }

    // =====================================================================
    // 组件：入口按钮
    // =====================================================================

    function Launcher(props) {
      const t = props.t
      const wide = props.wide !== false
      const snapshot = useStore()
      return h(
        'button',
        {
          type: 'button',
          className: cx('dcr-launcher', snapshot.open && 'dcr-launcher-on'),
          title: tt(t, 'title'),
          'aria-label': tt(t, 'title'),
          'aria-pressed': snapshot.open ? 'true' : 'false',
          onClick: () => (state.open ? closeWindow() : openWindow()),
        },
        icon('review', 16),
        wide ? h('span', { className: 'dcr-launcher-label' }, tt(t, 'shortTitle')) : null,
      )
    }

    // =====================================================================
    // 组件：窗口
    // =====================================================================

    function ReviewOverlay(props) {
      const t = props.t
      const snapshot = useStore()
      if (!snapshot.open) return null
      return h(ReviewBoundary, { t: t }, h(ReviewWindow, { t: t, snapshot: snapshot }))
    }

    /**
     * 窗口级错误边界：任何渲染异常都收敛成一条可见提示，而不是让整个
     * shell.overlay 条目崩掉、用户点了入口什么都没发生。
     */
    class ReviewBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        console.error('[dsh-code-review] review window crashed', error)
      }

      render() {
        if (this.state.error) {
          const message = String((this.state.error && this.state.error.message) || this.state.error)
          return h(
            'div',
            { className: 'dcr-backdrop', onMouseDown: (event) => event.target === event.currentTarget && closeWindow() },
            h(
              'div',
              { className: 'dcr-window', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': tt(this.props.t, 'title') },
              h('div', { className: 'dcr-banner dcr-banner-error' }, tt(this.props.t, 'renderFailed') + message),
              h(
                'div',
                { className: 'dcr-empty' },
                h('button', { type: 'button', className: 'dcr-primary', onClick: () => closeWindow() }, tt(this.props.t, 'close')),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    /** 右栏实际宽度：用户拖过就用拖动值，没拖过则按页签自动（关系图更宽）。 */
    function effectiveRightWidth(snapshot) {
      if (snapshot.rightWidth) return snapshot.rightWidth
      return snapshot.sideTab === 'graph' ? 620 : 380
    }

    function ReviewWindow(props) {
      const t = props.t
      const snapshot = props.snapshot
      const dialogRef = useRef(null)
      const [tip, setTip] = useState(null)
      const [manualRoot, setManualRoot] = useState('')
      const hideTimer = useRef(0)
      const showTimer = useRef(0)

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            event.preventDefault()
            closeWindow()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [])

      useEffect(() => {
        if (dialogRef.current) dialogRef.current.focus()
      }, [])

      const colorMode = useColorMode()

      useEffect(
        () => () => {
          window.clearTimeout(hideTimer.current)
          window.clearTimeout(showTimer.current)
        },
        [],
      )

      const cancelHide = useCallback(() => {
        window.clearTimeout(hideTimer.current)
      }, [])

      const scheduleHide = useCallback(() => {
        window.clearTimeout(showTimer.current)
        hideTimer.current = window.setTimeout(() => setTip(null), 180)
      }, [])

      const scheduleShow = useCallback((hunk, element, index, total) => {
        window.clearTimeout(hideTimer.current)
        window.clearTimeout(showTimer.current)
        const rect = element.getBoundingClientRect()
        showTimer.current = window.setTimeout(() => {
          const file = state.selection ? state.selection.path : ''
          const rev = state.selection && state.selection.rev ? state.selection.rev : undefined
          ensureHunkData(file, hunk, rev)
          setTip({
            key: hunkKey(file, hunk),
            hunk: hunk,
            file: file,
            rect: rect,
            index: typeof index === 'number' ? index : 0,
            total: typeof total === 'number' ? total : 1,
          })
        }, 160)
      }, [])

      const overview = snapshot.overview
      const changes = sortChanges((overview && overview.status) || [])
      const commits = (overview && overview.commits) || []

      return h(
        'div',
        {
          className: 'dcr-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeWindow()
          },
        },
        h(
          'div',
          {
            className: 'dcr-window',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': tt(t, 'title'),
            tabIndex: -1,
            ref: dialogRef,
            'data-dcr-theme': colorMode,
          },
          h(WindowHeader, { t: t, snapshot: snapshot, changes: changes }),
          snapshot.error
            ? h('div', { className: 'dcr-banner dcr-banner-error' }, snapshot.error)
            : null,
          snapshot.repoError ? h('div', { className: 'dcr-banner' }, snapshot.repoError) : null,
          !snapshot.repos.length && snapshot.busy !== 'repos'
            ? h(
                'div',
                { className: 'dcr-manual' },
                h('input', {
                  className: 'dcr-input',
                  type: 'text',
                  value: manualRoot,
                  placeholder: tt(t, 'manualRootPlaceholder'),
                  'aria-label': tt(t, 'manualRootPlaceholder'),
                  onChange: (event) => setManualRoot(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') loadRepos(manualRoot)
                  },
                }),
                h(
                  'button',
                  { type: 'button', className: 'dcr-primary', onClick: () => loadRepos(manualRoot) },
                  tt(t, 'scan'),
                ),
              )
            : null,
          h(
            'div',
            {
              className: 'dcr-body',
              style: {
                '--dcr-left-w': snapshot.leftWidth + 'px',
                '--dcr-right-w': effectiveRightWidth(snapshot) + 'px',
                '--dcr-split-ratio': String(snapshot.splitRatio),
              },
            },
            h(LeftColumn, { t: t, snapshot: snapshot, changes: changes, commits: commits }),
            h(Splitter, {
              title: tt(t, 'resizeLeft'),
              onDelta: (delta) => setLayout({ leftWidth: clampNumber(snapshot.leftWidth + delta, 200, 640, LAYOUT_DEFAULT.leftWidth) }),
              onReset: () => setLayout({ leftWidth: LAYOUT_DEFAULT.leftWidth }),
            }),
            h(CenterColumn, { t: t, snapshot: snapshot, scheduleShow: scheduleShow, scheduleHide: scheduleHide, cancelHide: cancelHide, tip: tip }),
            h(Splitter, {
              title: tt(t, 'resizeRight'),
              onDelta: (delta) => setLayout({ rightWidth: clampNumber(effectiveRightWidth(snapshot) - delta, 240, 1000, 380) }),
              onReset: () => setLayout({ rightWidth: LAYOUT_DEFAULT.rightWidth }),
            }),
            h(RightColumn, { t: t, snapshot: snapshot }),
          ),
          snapshot.busy ? h('div', { className: 'dcr-progress' }) : null,
        ),
        tip ? h(HoverTip, { t: t, tip: tip, snapshot: snapshot, cancelHide: cancelHide, scheduleHide: scheduleHide }) : null,
      )
    }

    function WindowHeader(props) {
      const t = props.t
      const snapshot = props.snapshot
      const overview = snapshot.overview
      return h(
        'div',
        { className: 'dcr-header' },
        h('div', { className: 'dcr-header-title' },
          icon('review', 18),
          h('span', null, tt(t, 'title')),
          h('span', { className: 'dcr-version', title: 'dsh-code-review' }, 'v' + CLIENT_VERSION),
        ),
        h(
          'div',
          { className: 'dcr-header-controls' },
          h(
            'select',
            {
              className: 'dcr-select',
              value: snapshot.cwd,
              onChange: (event) => selectRepo(event.target.value),
              'aria-label': tt(t, 'repoLabel'),
            },
            snapshot.repos.length === 0 ? h('option', { value: '' }, tt(t, 'noRepo')) : null,
            snapshot.repos.map((repo) =>
              h('option', { key: repo.path, value: repo.path }, repo.name),
            ),
          ),
          overview
            ? h(
                'span',
                { className: 'dcr-chip', title: overview.root },
                h('span', { className: 'dcr-chip-dot' }),
                overview.branch,
                overview.ahead ? h('span', { className: 'dcr-chip-ahead' }, '↑' + overview.ahead) : null,
                overview.behind ? h('span', { className: 'dcr-chip-behind' }, '↓' + overview.behind) : null,
              )
            : null,
          overview
            ? h(
                'span',
                { className: 'dcr-statline' },
                tt(t, 'statLine', {
                  files: overview.totals.files,
                  added: overview.totals.added,
                  removed: overview.totals.removed,
                }),
              )
            : null,
          h(
            'button',
            { type: 'button', className: 'dcr-iconbtn', title: tt(t, 'refresh'), onClick: () => refreshOverview() },
            icon('refresh', 15),
          ),
          h(
            'button',
            { type: 'button', className: 'dcr-iconbtn', title: tt(t, 'close'), onClick: () => closeWindow() },
            icon('close', 16),
          ),
        ),
      )
    }

    // =====================================================================
    // 组件：左栏（改动 / 提交）
    // =====================================================================

    function LeftColumn(props) {
      const t = props.t
      const snapshot = props.snapshot
      const changes = props.changes
      const commits = props.commits
      const selection = snapshot.selection
      const reviewedPaths = reviewedSet(snapshot.cwd)
      const pendingCount = changes.filter((entry) => reviewedPaths.indexOf(entry.path) < 0).length
      // 「只看未审」只过滤左侧列表，不删除任何东西；取消勾选后已审文件原样回来
      const visibleChanges = snapshot.hideReviewed
        ? changes.filter((entry) => reviewedPaths.indexOf(entry.path) < 0)
        : changes
      return h(
        'div',
        { className: 'dcr-col dcr-col-left' },
        h(
          'div',
          { className: 'dcr-tabs' },
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-tab', snapshot.tab === 'changes' && 'dcr-tab-on'),
              onClick: () => set({ tab: 'changes' }),
            },
            tt(t, 'tabChanges'),
            h('span', { className: 'dcr-tab-count' }, changes.length),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-tab', snapshot.tab === 'commits' && 'dcr-tab-on'),
              onClick: () => set({ tab: 'commits' }),
            },
            tt(t, 'tabCommits'),
            h('span', { className: 'dcr-tab-count' }, commits.length),
          ),
          h('span', { className: 'dcr-tabs-gap' }),
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-filter', snapshot.hideReviewed && 'dcr-filter-on'),
              title: tt(t, 'filterHint'),
              'aria-pressed': Boolean(snapshot.hideReviewed),
              disabled: changes.length === 0,
              onClick: () => setHideReviewed(!snapshot.hideReviewed),
            },
            icon('check', 12),
            tt(t, 'unreviewedCount', { count: pendingCount }),
          ),
        ),
        h(
          'div',
          { className: 'dcr-scroll' },
          snapshot.tab === 'changes'
            ? changes.length === 0
              ? h('div', { className: 'dcr-empty' }, tt(t, 'cleanTree'))
              : visibleChanges.length === 0
                ? h('div', { className: 'dcr-empty' }, tt(t, 'allReviewed'))
                : visibleChanges.map((entry) => h(FileRow, {
                    key: entry.path,
                    t: t,
                    entry: entry,
                    reviewed: reviewedPaths.indexOf(entry.path) >= 0,
                    active: Boolean(selection && selection.kind === 'file' && selection.path === entry.path),
                    onClick: () => selectFile(entry),
                    onToggleReviewed: () => toggleReviewed(entry.path),
                  }))
            : commits.map((commit) => h(CommitRow, {
                key: commit.hash,
                t: t,
                commit: commit,
                active: Boolean(selection && selection.kind === 'commit' && selection.rev === commit.hash),
                onClick: () => selectCommit(commit),
              })),
        ),
      )
    }

    function FileRow(props) {
      const t = props.t
      const entry = props.entry
      const meta = statusMeta(entry)
      const reviewed = Boolean(props.reviewed)
      return h(
        'div',
        {
          className: cx('dcr-row', props.active && 'dcr-row-on', reviewed && 'dcr-row-reviewed'),
          title: entry.path,
          role: 'button',
          tabIndex: 0,
          onClick: props.onClick,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            props.onClick()
          },
        },
        h('span', { className: cx('dcr-badge', 'dcr-badge-' + meta.tone) }, meta.letter),
        h(
          'span',
          { className: 'dcr-row-main' },
          h('span', { className: 'dcr-row-name' }, baseName(entry.path)),
          h('span', { className: 'dcr-row-path' }, dirName(entry.path)),
        ),
        h(
          'span',
          { className: 'dcr-row-stat' },
          entry.binary
            ? h('span', { className: 'dcr-binary-badge' }, tt(t, 'binary'))
            : [
                entry.added === null || entry.added === undefined ? null : h('span', { key: 'a', className: 'dcr-add' }, '+' + entry.added),
                entry.removed === null || entry.removed === undefined ? null : h('span', { key: 'r', className: 'dcr-del' }, '-' + entry.removed),
              ],
        ),
        h(
          'button',
          {
            type: 'button',
            className: cx('dcr-check', reviewed && 'dcr-check-on'),
            title: reviewed ? tt(t, 'markUnreviewed') : tt(t, 'markReviewed'),
            'aria-pressed': reviewed,
            'aria-label': reviewed ? tt(t, 'markUnreviewed') : tt(t, 'markReviewed'),
            onClick: (event) => {
              event.stopPropagation()
              event.preventDefault()
              props.onToggleReviewed()
            },
          },
          reviewed ? icon('check', 11) : null,
        ),
      )
    }

    function CommitRow(props) {
      const t = props.t
      const commit = props.commit
      return h(
        'button',
        {
          type: 'button',
          className: cx('dcr-row', 'dcr-row-commit', props.active && 'dcr-row-on'),
          title: commit.subject,
          onClick: props.onClick,
        },
        h('span', { className: 'dcr-hash' }, commit.short),
        h(
          'span',
          { className: 'dcr-row-main' },
          h('span', { className: 'dcr-row-name dcr-row-name-clip' }, commit.subject || tt(t, 'noMessage')),
          h('span', { className: 'dcr-row-path' }, commit.author + ' · ' + relativeTime(commit.date, t)),
        ),
      )
    }

    // =====================================================================
    // 组件：中栏（diff / 提交详情）
    // =====================================================================

    function CenterColumn(props) {
      const t = props.t
      const snapshot = props.snapshot
      const selection = snapshot.selection

      if (!selection) {
        return h('div', { className: 'dcr-col dcr-col-center' }, h('div', { className: 'dcr-empty dcr-empty-center' }, tt(t, 'pickFile')))
      }

      if (selection.kind === 'commit') {
        return h(CommitDetail, { t: t, snapshot: snapshot })
      }

      const diff = snapshot.diff
      const parsed = diff ? parseUnified(diff.text) : null
      const view = useMemo(() => buildSplitView(parsed), [parsed])
      return h(
        'div',
        { className: 'dcr-col dcr-col-center' },
        h(
          'div',
          { className: 'dcr-fileheader' },
          selection.kind === 'commitFile'
            ? h(
                'button',
                { type: 'button', className: 'dcr-back', onClick: () => backToCommit(), title: tt(t, 'backToCommit') },
                '←',
              )
            : null,
          h('span', { className: 'dcr-fileheader-path', title: selection.path }, selection.path),
          diff ? h('span', { className: 'dcr-mode-badge' }, tt(t, 'mode_' + diff.mode)) : null,
          parsed
            ? h(
                'span',
                { className: 'dcr-row-stat' },
                h('span', { className: 'dcr-add' }, '+' + parsed.hunks.reduce((sum, hunk) => sum + hunk.added.length, 0)),
                h('span', { className: 'dcr-del' }, '-' + parsed.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dcr-scroll dcr-diffscroll' },
          snapshot.busy === 'diff' ? h('div', { className: 'dcr-empty' }, tt(t, 'loading')) : null,
          snapshot.diffError ? h('div', { className: 'dcr-empty dcr-empty-error' }, snapshot.diffError) : null,
          !snapshot.busy && !snapshot.diffError && parsed && parsed.hunks.length === 0
            ? h(BinaryNotice, { t: t, diff: diff })
            : null,
          parsed && parsed.hunks.length
            ? h(
                'div',
                { className: 'dcr-splithead' },
                h('span', { className: 'dcr-splithead-cell' }, tt(t, 'splitBefore')),
                h('span', { className: 'dcr-splithead-cell' }, tt(t, 'splitAfter')),
              )
            : null,
          view.hunks.length
            ? h(
                'div',
                { className: 'dcr-diffbody' },
                view.hunks.map((entry, index) =>
                  h(SplitHunk, {
                    key: 'hunk-' + index,
                    t: t,
                    entry: entry,
                    blocks: view.blocks,
                    onEnter: props.scheduleShow,
                    onLeave: props.scheduleHide,
                  }),
                ),
                h(SplitGrip, {
                  ratio: snapshot.splitRatio,
                  title: tt(t, 'resizeSplit'),
                  onRatio: (ratio) => setLayout({ splitRatio: ratio }),
                  onReset: () => setLayout({ splitRatio: LAYOUT_DEFAULT.splitRatio }),
                }),
              )
            : null,
        ),
      )
    }

    /** 一个 hunk 的左右对照。 */
    function SplitHunk(props) {
      const t = props.t
      const entry = props.entry
      const hunk = entry.hunk
      const blocks = props.blocks || []

      return h(
        'div',
        { className: 'dcr-hunk' },
        h(
          'div',
          { className: 'dcr-hunkhead' },
          h('span', { className: 'dcr-hunkrange' }, hunk.header.replace(/^@@\s*/, '').replace(/\s*@@.*$/, '')),
          hunk.heading ? h('span', { className: 'dcr-hunkheading' }, hunk.heading) : null,
          h('span', { className: 'dcr-hunkhint' }, tt(t, 'hoverHint')),
        ),
        h(
          'div',
          { className: 'dcr-split' },
          entry.rows.map((row, index) => {
            const block = row.block >= 0 ? blocks[row.block] : null
            return h(
              'div',
              {
                key: index,
                className: cx('dcr-srow', 'dcr-srow-' + row.kind),
                onMouseEnter: block
                  ? (event) => props.onEnter(block, event.currentTarget, block.index, block.total)
                  : undefined,
                onMouseLeave: block ? props.onLeave : undefined,
              },
              h('span', { className: 'dcr-sno dcr-sno-left' }, row.left ? row.left.no : ''),
              h('span', { className: cx('dcr-scode', 'dcr-sleft', !row.left && 'dcr-sfiller') }, row.left ? renderCode(row.left.text) : ''),
              h('span', { className: 'dcr-sno dcr-sno-right' }, row.right ? row.right.no : ''),
              h('span', { className: cx('dcr-scode', 'dcr-sright', !row.right && 'dcr-sfiller') }, row.right ? renderCode(row.right.text) : ''),
            )
          }),
        ),
      )
    }

    function CommitDetail(props) {
      const t = props.t
      const snapshot = props.snapshot
      const commit = snapshot.commit
      if (!commit) {
        return h('div', { className: 'dcr-col dcr-col-center' }, h('div', { className: 'dcr-empty dcr-empty-center' }, tt(t, 'loading')))
      }
      return h(
        'div',
        { className: 'dcr-col dcr-col-center' },
        h(
          'div',
          { className: 'dcr-scroll' },
          h(
            'div',
            { className: 'dcr-commit-card' },
            h('div', { className: 'dcr-commit-subject' }, commit.message.split('\n')[0]),
            h(
              'div',
              { className: 'dcr-commit-meta' },
              h('span', { className: 'dcr-hash' }, commit.short),
              h('span', null, commit.author),
              h('span', null, absoluteTime(commit.date)),
            ),
            commit.message.indexOf('\n') !== -1
              ? h('pre', { className: 'dcr-commit-body' }, commit.message.split('\n').slice(1).join('\n').trim())
              : null,
            h('div', { className: 'dcr-commit-shortstat' }, commit.shortstat || ''),
          ),
          h(
            'div',
            { className: 'dcr-commit-files' },
            commit.files.map((file) =>
              h(
                'button',
                {
                  key: file.path,
                  type: 'button',
                  className: 'dcr-row',
                  onClick: () => selectCommitFile(file),
                },
                h('span', { className: cx('dcr-badge', 'dcr-badge-mod') }, String(file.status || 'M').charAt(0)),
                h(
                  'span',
                  { className: 'dcr-row-main' },
                  h('span', { className: 'dcr-row-name' }, baseName(file.path)),
                  h('span', { className: 'dcr-row-path' }, dirName(file.path)),
                ),
                icon('chevron', 14),
              ),
            ),
          ),
        ),
      )
    }

    function BinaryNotice(props) {
      const t = props.t
      const diff = props.diff
      if (!diff || !diff.binary) return h('div', { className: 'dcr-empty' }, tt(t, 'noDiff'))
      return h(
        'div',
        { className: 'dcr-binary' },
        h('div', { className: 'dcr-binary-title' }, tt(t, 'binaryTitle')),
        h('div', { className: 'dcr-hint' }, tt(t, 'binaryHint')),
        h(
          'div',
          { className: 'dcr-binary-sizes' },
          h('span', null, tt(t, 'binaryBefore') + '：' + formatBytes(diff.beforeBytes)),
          h('span', { className: 'dcr-binary-arrow' }, '→'),
          h('span', null, tt(t, 'binaryAfter') + '：' + formatBytes(diff.afterBytes)),
        ),
      )
    }

    /** 人类可读的字节数。 */
    function formatBytes(value) {
      if (value === null || value === undefined) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(2) + ' MB'
    }

    // =====================================================================
    // 组件：悬浮提示
    // =====================================================================

    function HoverTip(props) {
      const t = props.t
      const tip = props.tip
      const snapshot = props.snapshot
      const key = tip.key
      const annotation = hunkAnnotation(tip.file, tip.hunk)
      const blame = snapshot.blame[key]
      const analysis = snapshot.analyze[key]
      const reviewEntry = snapshot.hunkReviews ? snapshot.hunkReviews[tip.file] : null
      const review = reviewEntry && reviewEntry.reviews ? reviewEntry.reviews[tip.index] : null
      const sections = buildTipSections(t, tip.file, tip.hunk, annotation, blame, analysis, {
        review: review,
        index: tip.index,
        total: tip.total,
        busy: Boolean(reviewEntry && reviewEntry.busy),
      })

      const width = 380
      const margin = 12
      const rect = tip.rect
      let left = rect.right + margin
      if (left + width > window.innerWidth - margin) left = Math.max(margin, rect.left - width - margin)
      let top = rect.top
      if (top + 420 > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - 420 - margin)

      return h(
        'div',
        {
          className: 'dcr-tip',
          style: { left: left + 'px', top: top + 'px', width: width + 'px' },
          onMouseEnter: props.cancelHide,
          onMouseLeave: props.scheduleHide,
        },
        h(
          'div',
          { className: 'dcr-tip-head' },
          h('span', { className: 'dcr-tip-title' }, baseName(tip.file)),
          h('span', { className: 'dcr-tip-range' }, tt(t, 'tipRangeText', {
            start: tip.hunk.newStart,
            end: tip.hunk.newStart + Math.max(0, tip.hunk.newCount - 1),
          })),
        ),
        sections.map((section) =>
          h(
            'div',
            { key: section.key, className: 'dcr-tip-section' },
            h('div', { className: 'dcr-tip-label' }, section.label),
            section.items.map((item, index) => {
              if (item.kind === 'muted') return h('div', { key: index, className: 'dcr-tip-muted' }, item.value)
              if (item.kind === 'text') return h('div', { key: index, className: 'dcr-tip-text' }, item.value)
              if (item.kind === 'warn') return h('div', { key: index, className: 'dcr-tip-warn' }, item.value)
              if (item.kind === 'commit') {
                return h(
                  'div',
                  { key: index, className: 'dcr-tip-commit' },
                  h('span', { className: 'dcr-hash' }, item.short),
                  h('span', { className: 'dcr-tip-commit-body' },
                    item.label ? h('span', { className: 'dcr-tip-commit-label' }, item.label) : null,
                    h('span', { className: 'dcr-tip-commit-summary' }, item.summary),
                    h('span', { className: 'dcr-tip-commit-meta' }, item.author + ' · ' + relativeTime(item.date, t)),
                  ),
                )
              }
              return h(
                'div',
                { key: index, className: 'dcr-tip-code' },
                h(
                  'div',
                  { className: 'dcr-tip-code-head' },
                  h('span', { className: 'dcr-tip-code-path', title: item.path }, item.path + (item.line ? ':' + item.line : '')),
                  item.note ? h('span', { className: 'dcr-tip-code-note' }, item.note) : null,
                ),
                item.text ? h('code', { className: 'dcr-tip-code-text' }, item.text) : null,
              )
            }),
          ),
        ),
        annotation
          ? null
          : h('div', { className: 'dcr-tip-foot' }, tt(t, 'tipFooter')),
      )
    }

    // =====================================================================
    // 组件：右栏（说明 / 关系图）
    // =====================================================================

    function RightColumn(props) {
      const t = props.t
      const snapshot = props.snapshot
      const selection = snapshot.selection
      const file = selection && selection.path ? selection.path : ''
      const annotation = file ? fileAnnotation(file) : null
      const symbols = file ? mergedSymbols(file) : []
      const diff = snapshot.diff
      const parsed = diff ? parseUnified(diff.text) : null

      return h(
        'div',
        { className: 'dcr-col dcr-col-right' },
        h(
          'div',
          { className: 'dcr-tabs' },
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-tab', snapshot.sideTab === 'notes' && 'dcr-tab-on'),
              onClick: () => set({ sideTab: 'notes' }),
            },
            tt(t, 'tabNotes'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-tab', snapshot.sideTab === 'graph' && 'dcr-tab-on'),
              onClick: () => set({ sideTab: 'graph' }),
            },
            icon('graph', 14),
            tt(t, 'tabGraph'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: cx('dcr-tab', snapshot.sideTab === 'ai' && 'dcr-tab-on'),
              onClick: () => {
                set({ sideTab: 'ai' })
                loadModels()
              },
            },
            icon('spark', 14),
            tt(t, 'tabAi'),
            reviewStreaming(snapshot) ? h('span', { className: 'dcr-tab-dot' }) : null,
          ),
        ),
        h(
          'div',
          { className: 'dcr-scroll dcr-side' },
          snapshot.sideTab === 'notes'
            ? h(NotesPanel, { t: t, snapshot: snapshot, file: file, annotation: annotation, parsed: parsed, symbols: symbols })
            : snapshot.sideTab === 'graph'
              ? h(GraphPanel, { t: t, snapshot: snapshot, file: file, annotation: annotation, symbols: symbols })
              : h(AiPanel, { t: t, snapshot: snapshot, file: file, parsed: parsed, diff: diff }),
        ),
      )
    }

    /** 当前是否有审查在流式生成。 */
    function reviewStreaming(snapshot) {
      for (const key of Object.keys(snapshot.reviews)) {
        if (snapshot.reviews[key].status === 'streaming') return true
      }
      return false
    }

    function NotesPanel(props) {
      const t = props.t
      const snapshot = props.snapshot
      const file = props.file
      const annotation = props.annotation
      const parsed = props.parsed
      const symbols = props.symbols
      if (!file) return h('div', { className: 'dcr-empty' }, tt(t, 'pickFile'))

      return h(
        'div',
        { className: 'dcr-notes' },
        h(
          'div',
          { className: 'dcr-section' },
          h('div', { className: 'dcr-section-title' }, tt(t, 'notesOverview')),
          h('div', { className: 'dcr-kv' }, h('span', null, tt(t, 'notesFile')), h('span', { title: file }, baseName(file))),
          h('div', { className: 'dcr-kv' }, h('span', null, tt(t, 'notesHunks')), h('span', null, parsed ? String(parsed.hunks.length) : '0')),
          h('div', { className: 'dcr-kv' }, h('span', null, tt(t, 'notesLines')), h('span', null, parsed
            ? '+' + parsed.hunks.reduce((sum, hunk) => sum + hunk.added.length, 0) + ' / -' + parsed.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0)
            : '0')),
        ),
        h(
          'div',
          { className: 'dcr-section' },
          h('div', { className: 'dcr-section-title' }, tt(t, 'notesAnnotation')),
          snapshot.annotationError ? h('div', { className: 'dcr-empty dcr-empty-error' }, snapshot.annotationError) : null,
          annotation
            ? h(
                'div',
                { className: 'dcr-annotation' },
                annotation.title ? h('div', { className: 'dcr-annotation-title' }, annotation.title) : null,
                annotation.basis ? h('div', { className: 'dcr-annotation-block' }, h('span', { className: 'dcr-annotation-label' }, tt(t, 'tipBasis')), h('span', null, annotation.basis)) : null,
                annotation.logic ? h('div', { className: 'dcr-annotation-block' }, h('span', { className: 'dcr-annotation-label' }, tt(t, 'tipLogic')), h('span', null, annotation.logic)) : null,
                Array.isArray(annotation.references) && annotation.references.length
                  ? h('div', { className: 'dcr-annotation-block' },
                      h('span', { className: 'dcr-annotation-label' }, tt(t, 'tipReferences')),
                      annotation.references.map((reference, index) =>
                        h('code', { key: index, className: 'dcr-ref' }, reference.path + (Array.isArray(reference.lines) ? ':' + reference.lines[0] : '')),
                      ),
                    )
                  : null,
                Array.isArray(annotation.bindings) && annotation.bindings.length
                  ? h('div', { className: 'dcr-annotation-block' },
                      h('span', { className: 'dcr-annotation-label' }, tt(t, 'tipBindings')),
                      annotation.bindings.map((binding, index) =>
                        h('code', { key: index, className: 'dcr-ref' }, (binding.symbol ? binding.symbol + ' · ' : '') + (binding.path || '') + (binding.line ? ':' + binding.line : '')),
                      ),
                    )
                  : null,
              )
            : h('div', { className: 'dcr-hint' }, snapshot.annotations.source
                ? tt(t, 'annotationMissing', { file: baseName(file) })
                : tt(t, 'annotationNoFile')),
        ),
        h(
          'div',
          { className: 'dcr-section' },
          h('div', { className: 'dcr-section-title' }, tt(t, 'notesSymbols')),
          symbols.length === 0
            ? h('div', { className: 'dcr-hint' }, tt(t, 'notesSymbolsHint'))
            : symbols.slice(0, 12).map((symbol) =>
                h(
                  'div',
                  { key: symbol.name, className: 'dcr-symbol' },
                  h('code', { className: 'dcr-symbol-name' }, symbol.name),
                  h('span', { className: 'dcr-symbol-count' }, tt(t, 'symbolHits', { n: symbol.total })),
                ),
              ),
        ),
        snapshot.annotations.source
          ? h('div', { className: 'dcr-footnote' }, tt(t, 'annotationSource', { path: snapshot.annotations.source }))
          : h('div', { className: 'dcr-footnote' }, tt(t, 'annotationSourceMissing')),
      )
    }

    function AiPanel(props) {
      const t = props.t
      const snapshot = props.snapshot
      const file = props.file
      const mode = snapshot.reviewMode || 'file'
      const key = reviewKey(mode, file)
      const entry = snapshot.reviews[key]
      const streaming = Boolean(entry && entry.status === 'streaming')

      useEffect(() => {
        loadModels()
      }, [])

      if (mode === 'file' && !file) return h('div', { className: 'dcr-empty' }, tt(t, 'pickFile'))

      const catalog = snapshot.models
      const modelOptions = []
      modelOptions.push(h('option', { key: 'default', value: '' }, tt(t, 'reviewFollowDefault')))
      if (catalog && Array.isArray(catalog.providers)) {
        for (const provider of catalog.providers) {
          for (const model of provider.models || []) {
            modelOptions.push(h('option', { key: provider.id + '|' + model.id, value: provider.id + '|' + model.id }, provider.name + ' / ' + model.name))
          }
        }
      }

      return h(
        'div',
        { className: 'dcr-ai' },
        h(
          'div',
          { className: 'dcr-ai-controls' },
          h(
            'div',
            { className: 'dcr-seg' },
            h('button', {
              type: 'button',
              className: cx('dcr-segbtn', mode === 'file' && 'dcr-segbtn-on'),
              onClick: () => set({ reviewMode: 'file' }),
            }, tt(t, 'reviewThisFile')),
            h('button', {
              type: 'button',
              className: cx('dcr-segbtn', mode === 'all' && 'dcr-segbtn-on'),
              onClick: () => set({ reviewMode: 'all' }),
            }, tt(t, 'reviewAll')),
          ),
          h(
            'select',
            {
              className: 'dcr-select dcr-select-wide',
              value: snapshot.modelChoice || '',
              'aria-label': tt(t, 'reviewModel'),
              onChange: (event) => set({ modelChoice: event.target.value }),
            },
            modelOptions,
          ),
          streaming
            ? h('button', { type: 'button', className: 'dcr-primary dcr-danger', onClick: () => stopReview() }, tt(t, 'stopReview'))
            : h('button', { type: 'button', className: 'dcr-primary', onClick: () => startReview(mode) },
                entry ? tt(t, 'rerunReview') : tt(t, 'startReview')),
        ),
        entry && entry.meta
          ? h('div', { className: 'dcr-ai-meta' },
              tt(t, 'reviewModel') + '：' + entry.meta.provider + ' / ' + entry.meta.model,
              entry.meta.promptChars ? ' · ' + tt(t, 'reviewPromptChars', { n: entry.meta.promptChars }) : '',
            )
          : null,
        h(
          'label',
          { className: 'dcr-toggle', title: tt(t, 'autoHunkReviewHint') },
          h('input', {
            type: 'checkbox',
            checked: snapshot.autoHunkReview !== false,
            onChange: (event) => {
              const on = event.target.checked
              set({ autoHunkReview: on, hunkReviews: {} })
              if (on) loadHunkReviews(file, snapshot.diff)
            },
          }),
          h('span', null, tt(t, 'autoHunkReview')),
        ),
        h(ReviewHistory, { t: t, snapshot: snapshot }),
        !entry
          ? h('div', { className: 'dcr-hint dcr-ai-intro' }, tt(t, 'reviewIdle'))
          : entry.status === 'error'
            ? h('div', { className: 'dcr-empty dcr-empty-error' }, (entry.error || tt(t, 'reviewFailed')) +
                (entry.text ? '' : ''))
            : entry.parsed
              ? h(ReviewResult, { t: t, parsed: entry.parsed, stopped: entry.stopped })
              : h(
                  'div',
                  { className: 'dcr-ai-raw' },
                  streaming
                    ? h('div', { className: 'dcr-ai-streaming' },
                        tt(t, 'reviewStreaming') +
                          (entry.thinking ? ' · ' + tt(t, 'reviewThinking', { n: entry.thinking }) : ''))
                    : null,
                  entry.text
                    ? h('pre', { className: 'dcr-ai-pre' }, entry.text)
                    : h('div', { className: 'dcr-hint' }, tt(t, 'reviewStreaming')),
                  !streaming && entry.text ? h('div', { className: 'dcr-footnote' }, tt(t, 'reviewRawFallback')) : null,
                ),
        entry && entry.stopped ? h('div', { className: 'dcr-footnote' }, tt(t, 'reviewStopped')) : null,
        entry && entry.truncated ? h('div', { className: 'dcr-footnote dcr-footnote-warn' }, tt(t, 'reviewTruncated')) : null,
      )
    }

    /** 审查面板里的「历史」：这个文件之前是怎么变的。 */
    function ReviewHistory(props) {
      const t = props.t
      const snapshot = props.snapshot
      const history = snapshot.history || { path: '', commits: [], busy: false }
      if (!history.path) return null
      return h(
        'div',
        { className: 'dcr-rv-section' },
        h('div', { className: 'dcr-rv-title' }, tt(t, 'secHistory')),
        history.busy
          ? h('div', { className: 'dcr-hint' }, tt(t, 'loading'))
          : history.error
            ? h('div', { className: 'dcr-hint dcr-hint-error' }, history.error)
            : history.commits.length === 0
              ? h('div', { className: 'dcr-hint' }, tt(t, 'historyEmpty'))
              : h(
                  'div',
                  { className: 'dcr-hist' },
                  history.commits.map((commit) =>
                    h(
                      'button',
                      {
                        key: commit.hash,
                        type: 'button',
                        className: 'dcr-hist-row',
                        title: commit.subject,
                        onClick: () => selectCommit(commit),
                      },
                      h('span', { className: 'dcr-hash' }, commit.short),
                      h(
                        'span',
                        { className: 'dcr-hist-main' },
                        h('span', { className: 'dcr-hist-subject' }, commit.subject || tt(t, 'noMessage')),
                        h(
                          'span',
                          { className: 'dcr-hist-meta' },
                          commit.author + ' · ' + relativeTime(commit.date, t) +
                            (commit.added === null || commit.added === undefined
                              ? ''
                              : ' · +' + commit.added + '/-' + commit.removed),
                        ),
                      ),
                    ),
                  ),
                ),
      )
    }

    /** 结构化审查结果。 */
    function ReviewResult(props) {
      const t = props.t
      const parsed = props.parsed || {}
      const risks = Array.isArray(parsed.risks) ? parsed.risks : []
      const compliance = Array.isArray(parsed.compliance) ? parsed.compliance : []
      const similar = parsed.similar || null

      const list = (title, items) =>
        Array.isArray(items) && items.length
          ? h(
              'div',
              { className: 'dcr-rv-section' },
              h('div', { className: 'dcr-rv-title' }, title),
              h('ul', { className: 'dcr-rv-list' }, items.map((item, index) => h('li', { key: index }, String(item)))),
            )
          : null

      return h(
        'div',
        { className: 'dcr-review' },
        parsed.summary ? h('div', { className: 'dcr-rv-summary' }, String(parsed.summary)) : null,
        list(tt(t, 'secWhat'), parsed.what),
        list(tt(t, 'secLogic'), parsed.logic),
        parsed.history && (parsed.history.before || parsed.history.context)
          ? h(
              'div',
              { className: 'dcr-rv-section' },
              h('div', { className: 'dcr-rv-title' }, tt(t, 'secHistoryAi')),
              parsed.history.before
                ? h('div', { className: 'dcr-rv-hist' },
                    h('span', { className: 'dcr-rv-hist-label' }, tt(t, 'histBefore')),
                    h('span', null, String(parsed.history.before)))
                : null,
              parsed.history.context
                ? h('div', { className: 'dcr-rv-hist' },
                    h('span', { className: 'dcr-rv-hist-label' }, tt(t, 'histContext')),
                    h('span', null, String(parsed.history.context)))
                : null,
            )
          : null,
        risks.length
          ? h(
              'div',
              { className: 'dcr-rv-section' },
              h('div', { className: 'dcr-rv-title' }, tt(t, 'secRisks')),
              risks.map((risk, index) =>
                h(
                  'div',
                  { key: index, className: 'dcr-rv-risk' },
                  h(
                    'div',
                    { className: 'dcr-rv-risk-head' },
                    h('span', { className: cx('dcr-rv-badge', 'dcr-rv-' + (risk.level || 'low')) }, tt(t, 'risk_' + (risk.level || 'low'))),
                    h('span', { className: 'dcr-rv-risk-title' }, String(risk.title || '')),
                  ),
                  risk.detail ? h('div', { className: 'dcr-rv-risk-detail' }, String(risk.detail)) : null,
                  risk.where ? h('code', { className: 'dcr-rv-where' }, String(risk.where)) : null,
                ),
              ),
            )
          : h('div', { className: 'dcr-rv-section' },
              h('div', { className: 'dcr-rv-title' }, tt(t, 'secRisks')),
              h('div', { className: 'dcr-hint' }, tt(t, 'noRisks'))),
        similar
          ? h(
              'div',
              { className: 'dcr-rv-section' },
              h('div', { className: 'dcr-rv-title' }, tt(t, 'secSimilar')),
              h(
                'div',
                { className: 'dcr-rv-similar' },
                h('span', { className: cx('dcr-rv-badge', 'dcr-rv-verdict') }, String(similar.verdict || '')),
                similar.detail ? h('span', { className: 'dcr-rv-similar-detail' }, String(similar.detail)) : null,
              ),
              Array.isArray(similar.peers) && similar.peers.length
                ? h(
                    'div',
                    { className: 'dcr-rv-peers' },
                    similar.peers.map((peer, index) =>
                      h(
                        'div',
                        { key: index, className: 'dcr-rv-peer' },
                        h('code', { className: 'dcr-rv-peer-path' }, String(peer.path || '')),
                        h('span', { className: 'dcr-rv-peer-note' }, String(peer.note || '')),
                      ),
                    ),
                  )
                : null,
            )
          : null,
        h(
          'div',
          { className: 'dcr-rv-section' },
          h('div', { className: 'dcr-rv-title' }, tt(t, 'secCompliance')),
          compliance.length
            ? compliance.map((item, index) =>
                h(
                  'div',
                  { key: index, className: 'dcr-rv-comp' },
                  h(
                    'div',
                    { className: 'dcr-rv-comp-head' },
                    h('span', { className: cx('dcr-rv-badge', 'dcr-rv-' + (item.status || 'warn')) }, tt(t, 'status_' + (item.status || 'warn'))),
                    h('span', { className: 'dcr-rv-comp-rule' }, String(item.rule || '')),
                  ),
                  item.detail ? h('div', { className: 'dcr-rv-comp-detail' }, String(item.detail)) : null,
                  item.source ? h('div', { className: 'dcr-rv-source' }, String(item.source)) : null,
                ),
              )
            : h('div', { className: 'dcr-hint' }, tt(t, 'noCompliance')),
        ),
        list(tt(t, 'secSuggestions'), parsed.suggestions),
      )
    }

    function GraphPanel(props) {
      const t = props.t
      const snapshot = props.snapshot
      const file = props.file
      const annotation = props.annotation
      const symbols = props.symbols
      if (!file) return h('div', { className: 'dcr-empty' }, tt(t, 'pickFile'))

      const hasData = symbols.length > 0 || (annotation && annotation.diagram)
      if (!hasData) {
        return h(
          'div',
          { className: 'dcr-graph-empty' },
          h('div', { className: 'dcr-hint' }, tt(t, 'graphHint')),
          h(
            'button',
            {
              type: 'button',
              className: 'dcr-primary',
              disabled: snapshot.graphBusy,
              onClick: () => analyzeFileForGraph(),
            },
            snapshot.graphBusy ? tt(t, 'graphBuilding') : tt(t, 'graphBuild'),
          ),
        )
      }
      return h(LogicGraph, { t: t, file: file, annotation: annotation, symbols: symbols })
    }

    function LogicGraph(props) {
      const t = props.t
      const file = props.file
      const annotation = props.annotation
      const symbols = props.symbols || []

      const model = useMemo(() => buildGraphModel(file, annotation, symbols), [file, annotation, symbols])
      if (!model.nodes.length) return h('div', { className: 'dcr-empty' }, tt(t, 'graphNoData'))

      return h(
        'div',
        { className: 'dcr-graph' },
        h(
          'svg',
          {
            viewBox: '0 0 ' + model.width + ' ' + model.height,
            width: '100%',
            role: 'img',
            'aria-label': tt(t, 'tabGraph'),
          },
          h(
            'defs',
            null,
            h(
              'marker',
              { id: 'dcr-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
              h('path', { d: 'M 0 0 L 10 5 L 0 10 z', className: 'dcr-arrow' }),
            ),
          ),
          model.edges.map((edge, index) =>
            h(
              'g',
              { key: 'e' + index },
              h('path', { className: 'dcr-edge', d: edge.path, markerEnd: 'url(#dcr-arrow)' }),
              edge.label
                ? h('text', { className: 'dcr-edge-label', x: edge.labelX, y: edge.labelY, textAnchor: 'middle' }, edge.label)
                : null,
            ),
          ),
          model.nodes.map((node) =>
            h(
              'g',
              { key: node.id, className: 'dcr-node-group' },
              h('rect', { className: 'dcr-node dcr-node-' + node.kind, x: node.x, y: node.y, width: node.width, height: node.height, rx: 7 }),
              h('text', { className: 'dcr-node-label', x: node.x + 10, y: node.y + 20 }, node.label),
              node.sublabel
                ? h('text', { className: 'dcr-node-sub', x: node.x + 10, y: node.y + 36 }, node.sublabel)
                : null,
            ),
          ),
        ),
        h('div', { className: 'dcr-graph-legend' },
          h('span', { className: 'dcr-legend dcr-legend-target' }, tt(t, 'legendTarget')),
          h('span', { className: 'dcr-legend dcr-legend-def' }, tt(t, 'legendDef')),
          h('span', { className: 'dcr-legend dcr-legend-ref' }, tt(t, 'legendRef')),
          h('span', { className: 'dcr-legend dcr-legend-commit' }, tt(t, 'legendCommit')),
        ),
      )
    }

    /** 生成关系图模型：定义 → 目标 → 引用，外加提交节点。 */
    function buildGraphModel(file, annotation, symbols) {
      const width = 560
      const nodeWidth = 168
      const nodeHeight = 46
      const columns = { left: 8, center: 196, right: 384 }
      const nodes = []
      const edges = []
      const ids = new Map()

      /** 节点/边上的文字按列宽截断，避免 SVG 里溢出压到别的节点。 */
      function clip(text, limit) {
        const value = String(text === undefined || text === null ? '' : text)
        return value.length > limit ? value.slice(0, limit - 1) + '…' : value
      }

      function addNode(id, label, sublabel, kind, column) {
        if (ids.has(id)) return ids.get(id)
        const node = {
          id: id,
          label: clip(label, 20),
          sublabel: clip(sublabel, 26),
          kind: kind,
          column: column,
          x: columns[column],
          y: 0,
          width: nodeWidth,
          height: nodeHeight,
        }
        ids.set(id, node)
        nodes.push(node)
        return node
      }

      // 标注里给了手绘关系图时优先用它
      if (annotation && annotation.diagram && Array.isArray(annotation.diagram.nodes) && annotation.diagram.nodes.length) {
        const diagramNodes = annotation.diagram.nodes.slice(0, 18)
        const columnOf = { left: 'left', center: 'center', right: 'right' }
        for (const raw of diagramNodes) {
          const column = columnOf[raw.column] || 'center'
          const kind = raw.kind === 'def' ? 'def' : raw.kind === 'ref' ? 'ref' : raw.kind === 'commit' ? 'commit' : 'target'
          addNode(String(raw.id || raw.label), String(raw.label || raw.id || ''), raw.note || '', kind, column)
        }
        const byId = ids
        for (const raw of annotation.diagram.edges || []) {
          const from = byId.get(String(raw.from))
          const to = byId.get(String(raw.to))
          if (from && to) edges.push({ from: from, to: to, label: raw.label || '' })
        }
      } else {
        const target = addNode('target', baseName(file), dirName(file) || '.', 'target', 'center')
        const defFiles = new Map()
        const refFiles = new Map()
        for (const symbol of symbols) {
          for (const item of symbol.defs || []) {
            if (item.target) continue
            if (!defFiles.has(item.path)) defFiles.set(item.path, { symbols: new Set(), sample: item })
            defFiles.get(item.path).symbols.add(symbol.name)
          }
          for (const item of symbol.refs || []) {
            if (item.target) continue
            if (!refFiles.has(item.path)) refFiles.set(item.path, { symbols: new Set(), sample: item })
            refFiles.get(item.path).symbols.add(symbol.name)
          }
        }
        for (const [filePath, info] of Array.from(defFiles.entries()).slice(0, 8)) {
          const node = addNode('def:' + filePath, baseName(filePath), dirName(filePath), 'def', 'left')
          edges.push({ from: node, to: target, label: Array.from(info.symbols).slice(0, 2).join(', ') })
        }
        for (const [filePath, info] of Array.from(refFiles.entries()).slice(0, 8)) {
          const node = addNode('ref:' + filePath, baseName(filePath), dirName(filePath), 'ref', 'right')
          edges.push({ from: target, to: node, label: Array.from(info.symbols).slice(0, 2).join(', ') })
        }
      }

      // 垂直排布
      const byColumn = { left: [], center: [], right: [] }
      for (const node of nodes) byColumn[node.column].push(node)
      let maxRows = 1
      for (const column of Object.keys(byColumn)) maxRows = Math.max(maxRows, byColumn[column].length)
      const height = Math.max(300, maxRows * (nodeHeight + 26) + 40)
      for (const column of Object.keys(byColumn)) {
        const list = byColumn[column]
        const total = list.length * nodeHeight + Math.max(0, list.length - 1) * 26
        let y = Math.max(16, (height - total) / 2)
        for (const node of list) {
          node.y = y
          y += nodeHeight + 26
        }
      }

      // 边几何
      const positioned = []
      for (const edge of edges) {
        const from = edge.from
        const to = edge.to
        if (!from || !to) continue
        const startX = from.x + from.width
        const startY = from.y + from.height / 2
        const endX = to.x
        const endY = to.y + to.height / 2
        let d
        if (startX <= endX) {
          const midX = (startX + endX) / 2
          d = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
        } else {
          const midY = (startY + endY) / 2
          d = `M ${startX} ${startY} C ${startX + 40} ${midY}, ${endX - 40} ${midY}, ${endX} ${endY}`
        }
        positioned.push({
          path: d,
          label: clip(edge.label, 18),
          labelX: (startX + endX) / 2,
          labelY: (startY + endY) / 2 - 4,
        })
      }

      return { width: width, height: height, nodes: nodes, edges: positioned }
    }

    // =====================================================================
    // 样式
    // =====================================================================

    const CSS = `
.dcr-launcher{display:inline-flex;align-items:center;gap:8px;height:32px;max-width:180px;min-width:0;padding:0 10px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;line-height:1}
.dcr-launcher:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dcr-launcher-on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l1)}
.dcr-launcher-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.dcr-backdrop{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.44);pointer-events:auto;padding:10px}
.dcr-window{position:relative;display:flex;flex-direction:column;width:min(1820px,98vw);height:min(1120px,96vh);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 28px 72px rgba(0,0,0,.34);overflow:hidden;outline:none;font-size:13px}
.dcr-header{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:0 0 auto}
.dcr-header-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;white-space:nowrap}
.dcr-version{font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;line-height:16px;white-space:nowrap}
.dcr-header-controls{display:flex;align-items:center;gap:10px;min-width:0}
.dcr-select{height:28px;max-width:220px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dcr-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.dcr-chip-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:0 0 auto}
.dcr-chip-ahead{color:var(--dsw-alias-state-success-primary)}
.dcr-chip-behind{color:var(--dsw-alias-state-warn-primary)}
.dcr-statline{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcr-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dcr-iconbtn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}

.dcr-body{display:flex;min-height:0;flex:1 1 auto}
.dcr-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.dcr-col-left{flex:0 0 var(--dcr-left-w,280px);background:var(--dsw-alias-bg-layer-2)}
.dcr-col-center{flex:1 1 auto;background:var(--dsw-alias-bg-base)}
.dcr-col-right{flex:0 0 var(--dcr-right-w,380px);background:var(--dsw-alias-bg-layer-2)}

.dcr-ai{display:flex;flex-direction:column;gap:10px}
.dcr-ai-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dcr-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.dcr-segbtn{height:28px;padding:0 10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dcr-segbtn:hover{color:var(--dsw-alias-label-primary)}
.dcr-segbtn-on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dcr-select-wide{max-width:210px;flex:1 1 150px;min-width:0}
.dcr-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dcr-ai-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dcr-ai-intro{padding:8px 0}
.dcr-ai-streaming{font-size:11px;color:var(--dsw-alias-brand-primary);margin-bottom:6px}
.dcr-ai-pre{margin:0;padding:9px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto}
.dcr-review{display:flex;flex-direction:column;gap:12px}
.dcr-rv-summary{font-size:13px;font-weight:600;line-height:1.65}
.dcr-rv-section{display:flex;flex-direction:column;gap:6px}
.dcr-rv-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.dcr-rv-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:1.65}
.dcr-rv-risk{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:3px}
.dcr-rv-risk-head{display:flex;gap:7px;align-items:center}
.dcr-rv-risk-title{font-weight:600;font-size:12px}
.dcr-rv-risk-detail{font-size:11.5px;line-height:1.65}
.dcr-rv-where{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dcr-rv-badge{font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:0 0 auto;white-space:nowrap}
.dcr-rv-high{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-rv-medium{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcr-rv-pass{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcr-rv-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcr-rv-fail{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-rv-verdict{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dcr-rv-similar{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.65}
.dcr-rv-similar-detail{min-width:0}
.dcr-rv-peers{display:flex;flex-direction:column;gap:6px}
.dcr-rv-peer{display:flex;flex-direction:column;gap:1px;border-left:2px solid var(--dsw-alias-border-l1);padding-left:8px}
.dcr-rv-peer-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dcr-rv-peer-note{font-size:11.5px;line-height:1.6}
.dcr-rv-comp{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 9px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-layer-1)}
.dcr-rv-comp-head{display:flex;gap:7px;align-items:center}
.dcr-rv-comp-rule{font-size:12px;font-weight:600}
.dcr-rv-comp-detail{font-size:11.5px;line-height:1.65}
.dcr-rv-source{font-size:10px;color:var(--dsw-alias-label-secondary)}
.dcr-tab-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);display:inline-block}
.dcr-rv-title-stat{display:inline-flex;gap:6px;margin-left:8px;font-weight:400;text-transform:none;letter-spacing:0}
.dcr-rv-title-hunks{color:var(--dsw-alias-label-secondary)}
.dcr-rvdiff{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:auto;max-height:42vh;background:var(--dsw-alias-bg-base)}
.dcr-md-hunk{border-bottom:1px solid var(--dsw-alias-border-l1)}
.dcr-md-hunk:last-child{border-bottom:none}
.dcr-md-range{padding:3px 9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);position:sticky;top:0}
.dcr-md-line{display:flex;gap:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55;white-space:pre}
.dcr-md-no{flex:0 0 42px;text-align:right;padding-right:6px;color:var(--dsw-alias-label-secondary);opacity:.65;user-select:none}
.dcr-md-sign{flex:0 0 12px;text-align:center;user-select:none}
.dcr-md-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
.dcr-md-add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dcr-md-del{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent)}
.dcr-md-add .dcr-md-sign{color:var(--dsw-alias-state-success-primary)}
.dcr-md-del .dcr-md-sign{color:var(--dsw-alias-state-error-primary)}
.dcr-hist{display:flex;flex-direction:column;gap:2px}
.dcr-hist-row{display:flex;gap:8px;align-items:baseline;width:100%;padding:5px 7px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dcr-hist-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.dcr-hist-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.dcr-hist-subject{font-size:11.5px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-hist-meta{font-size:10px;color:var(--dsw-alias-label-secondary)}
.dcr-rv-hist{display:flex;gap:6px;font-size:12px;line-height:1.65}
.dcr-rv-hist-label{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:11px}
.dcr-binary-badge{font-size:9.5px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dcr-binary{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin:14px}
.dcr-binary-title{font-size:13px;font-weight:600}
.dcr-binary-sizes{display:flex;gap:8px;align-items:center;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dcr-binary-arrow{color:var(--dsw-alias-label-secondary)}
.dcr-hint-error{color:var(--dsw-alias-state-error-primary)}
.dcr-toggle{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dcr-toggle input{margin:0;cursor:pointer}

.dcr-tabs{display:flex;gap:2px;padding:8px 10px 0;flex:0 0 auto}
.dcr-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;border-radius:6px 6px 0 0}
.dcr-tab:hover{color:var(--dsw-alias-label-primary)}
.dcr-tab-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.dcr-tab-count{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:1px 6px}

.dcr-scroll{overflow:auto;min-height:0;flex:1 1 auto;padding:8px}
.dcr-diffscroll{padding:0 0 24px}
.dcr-empty{padding:18px 14px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dcr-empty-center{display:flex;align-items:center;justify-content:center;height:100%}
.dcr-empty-error{color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}

.dcr-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dcr-row:hover{background:var(--dsw-alias-bg-layer-1)}
.dcr-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dcr-row-on{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.dcr-row-main{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1 1 auto}
.dcr-row-name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcr-row-name-clip{max-width:100%}
.dcr-row-path{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcr-row-stat{display:flex;gap:6px;font-size:11px;flex:0 0 auto}
/* 审阅标记：平时半透明的小圆圈，勾上后常亮 */
.dcr-check{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;padding:0;border:1.5px solid var(--dsw-alias-border-l2);border-radius:50%;background:transparent;color:transparent;cursor:pointer;opacity:.32;transition:opacity .12s,border-color .12s,background .12s}
.dcr-row:hover .dcr-check{opacity:1}
.dcr-check:hover{border-color:var(--dsw-alias-state-success-primary)}
.dcr-check-on{opacity:1;border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}
.dcr-row-reviewed .dcr-row-name,.dcr-row-reviewed .dcr-row-path,.dcr-row-reviewed .dcr-badge,.dcr-row-reviewed .dcr-row-stat{opacity:.45}
.dcr-row-reviewed .dcr-row-name{text-decoration:line-through;text-decoration-color:var(--dsw-alias-label-secondary)}
.dcr-tabs-gap{flex:1 1 auto}
.dcr-filter{display:inline-flex;align-items:center;gap:4px;height:22px;margin:0 0 6px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.dcr-filter:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.dcr-filter-on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dcr-filter:disabled{opacity:.45;cursor:default}
.dcr-add{color:var(--dsw-alias-state-success-primary)}
.dcr-del{color:var(--dsw-alias-state-error-primary)}
.dcr-badge{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;font-size:10.5px;font-weight:600;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dcr-badge-new{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dcr-badge-del{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-badge-conflict{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dcr-hash{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:1px 5px;flex:0 0 auto}
.dcr-row-commit{align-items:flex-start}

.dcr-fileheader{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:0 0 auto;min-width:0}
.dcr-fileheader-path{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.dcr-mode-badge{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;flex:0 0 auto}
.dcr-back{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto}

.dcr-hunk{margin:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dcr-hunk:hover{border-color:var(--dsw-alias-border-l2)}
.dcr-hunkhead{display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:help}
.dcr-hunkrange{color:var(--dsw-alias-brand-primary)}
.dcr-hunkheading{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;font-family:inherit}
.dcr-hunkhint{margin-left:auto;font-family:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75;white-space:nowrap}
.dcr-hunkbody{overflow-x:auto}
.dcr-line{display:flex;align-items:flex-start;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.62;white-space:pre}
.dcr-lineno{flex:0 0 auto;width:44px;padding-right:8px;text-align:right;color:var(--dsw-alias-state-idle-primary);user-select:none}
.dcr-sign{flex:0 0 auto;width:14px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dcr-code{flex:1 1 auto;padding-right:12px;white-space:pre}
.dcr-line-add{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)}
.dcr-line-del{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)}
.dcr-line-add .dcr-sign{color:var(--dsw-alias-state-success-primary)}
.dcr-line-del .dcr-sign{color:var(--dsw-alias-state-error-primary)}
.dcr-splithead{display:grid;grid-template-columns:calc(48px + (100% + 20px - 96px)*var(--dcr-split-ratio,.5)) 1fr;margin:8px 10px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:9px 9px 0 0;background:var(--dsw-alias-bg-layer-2);font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden}
.dcr-splithead-cell{padding:5px 10px;text-align:center;border-right:1px solid var(--dsw-alias-border-l1)}
.dcr-splithead-cell:last-child{border-right:none}
.dcr-split{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.62}
.dcr-srow{display:grid;grid-template-columns:48px minmax(0,calc((100% - 96px)*var(--dcr-split-ratio,.5))) 48px minmax(0,1fr);align-items:stretch}
/* 可拖拽分隔：两栏之间的竖条 */
.dcr-splitter{flex:0 0 5px;position:relative;cursor:col-resize;z-index:3;background:transparent}
.dcr-splitter::after{content:'';position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1);transition:background .12s,width .12s,left .12s}
.dcr-splitter:hover::after,.dcr-splitter-on::after{left:1px;width:3px;background:var(--dsw-alias-brand-primary)}
/* 差异视图中间的左右分栏手柄 */
.dcr-diffbody{position:relative}
.dcr-grip{position:absolute;top:0;bottom:0;left:calc(48px + (100% - 96px)*var(--dcr-split-ratio,.5));width:11px;margin-left:-5px;cursor:col-resize;z-index:6}
.dcr-grip::after{content:'';position:absolute;top:0;bottom:0;left:5px;width:1px;background:var(--dsw-alias-border-l1);transition:background .12s,width .12s,left .12s}
.dcr-grip:hover::after,.dcr-grip-on::after{left:4px;width:3px;background:var(--dsw-alias-brand-primary)}
.dcr-sno{padding-right:8px;text-align:right;color:var(--dsw-alias-state-idle-primary);user-select:none;white-space:nowrap}
.dcr-scode{padding:0 10px;white-space:pre;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dcr-sright{border-left:1px solid var(--dsw-alias-border-l1)}
.dcr-sfiller{background:repeating-linear-gradient(45deg,transparent,transparent 4px,color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent) 4px,color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent) 8px)}
.dcr-srow-add .dcr-sright{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent)}
.dcr-srow-del .dcr-sleft{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dcr-srow-mod .dcr-sleft{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent)}
.dcr-srow-mod .dcr-sright{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent)}
.dcr-srow-add .dcr-sno-right,.dcr-srow-mod .dcr-sno-right{color:var(--dsw-alias-state-success-primary)}
.dcr-srow-del .dcr-sno-left,.dcr-srow-mod .dcr-sno-left{color:var(--dsw-alias-state-error-primary)}
.dcr-srow:hover .dcr-scode{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
/* Rider / IntelliJ Light 调色板；暗主题由 [data-dcr-theme="dark"] 覆盖 */
.dcr-window{--dcr-syn-kw:#0033B3;--dcr-syn-typ:#1A1A1A;--dcr-syn-fn:#00627A;--dcr-syn-str:#067D17;--dcr-syn-num:#1750EB;--dcr-syn-cmt:#8C8C8C;--dcr-syn-ann:#9E880D;--dcr-syn-fld:#871094;--dcr-syn-cst:#871094}
/* Rider / Darcula 调色板 */
.dcr-window[data-dcr-theme="dark"]{--dcr-syn-kw:#CC7832;--dcr-syn-typ:#A9B7C6;--dcr-syn-fn:#FFC66D;--dcr-syn-str:#6A8759;--dcr-syn-num:#6897BB;--dcr-syn-cmt:#808080;--dcr-syn-ann:#BBB529;--dcr-syn-fld:#9876AA;--dcr-syn-cst:#9876AA}
.dcr-sy-kw{color:var(--dcr-syn-kw);font-weight:600}
.dcr-sy-typ{color:var(--dcr-syn-typ)}
.dcr-sy-fn{color:var(--dcr-syn-fn)}
.dcr-sy-str{color:var(--dcr-syn-str)}
.dcr-sy-num{color:var(--dcr-syn-num)}
.dcr-sy-ann{color:var(--dcr-syn-ann)}
.dcr-sy-cmt{color:var(--dcr-syn-cmt)}
.dcr-sy-fld{color:var(--dcr-syn-fld)}
.dcr-sy-cst{color:var(--dcr-syn-cst);font-style:italic}

.dcr-tip{position:fixed;z-index:80;max-height:min(420px,80vh);overflow:auto;padding:12px 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 18px 44px rgba(0,0,0,.3);font-size:12px;line-height:1.55}
.dcr-tip-head{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.dcr-tip-title{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-tip-range{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dcr-tip-section{padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dcr-tip-label{font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary);margin-bottom:4px;letter-spacing:.02em}
.dcr-tip-text{color:var(--dsw-alias-label-primary)}
.dcr-tip-warn{color:var(--dsw-alias-state-warn-primary)}
.dcr-tip-muted{color:var(--dsw-alias-label-secondary)}
.dcr-tip-commit{display:flex;gap:7px;align-items:flex-start;margin-top:3px}
.dcr-tip-commit-body{display:flex;flex-direction:column;gap:1px;min-width:0}
.dcr-tip-commit-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-tip-commit-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dcr-tip-commit-label{font-size:10.5px;color:var(--dsw-alias-brand-primary)}
.dcr-tip-code{margin-top:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:5px 7px;background:var(--dsw-alias-bg-base)}
.dcr-tip-code-head{display:flex;gap:8px;align-items:baseline;min-width:0}
.dcr-tip-code-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.dcr-tip-code-note{font-size:10.5px;color:var(--dsw-alias-brand-primary);flex:0 0 auto}
.dcr-tip-code-text{display:block;margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary)}
.dcr-tip-foot{margin-top:8px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l1);font-size:10.5px;color:var(--dsw-alias-label-secondary)}

.dcr-side{padding:10px 12px}
.dcr-notes{display:flex;flex-direction:column;gap:14px}
.dcr-section{display:flex;flex-direction:column;gap:6px}
.dcr-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.dcr-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--dsw-alias-label-primary);min-width:0}
.dcr-kv>span:first-child{color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dcr-kv>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcr-annotation{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.dcr-annotation-title{font-weight:600;font-size:12.5px}
.dcr-annotation-block{display:flex;flex-direction:column;gap:2px;font-size:12px}
.dcr-annotation-label{font-size:10.5px;color:var(--dsw-alias-brand-primary)}
.dcr-ref{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcr-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
.dcr-footnote{font-size:10.5px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}
.dcr-footnote-warn{color:var(--dsw-alias-state-warn-primary);border-top-color:var(--dsw-alias-state-warn-primary)}
.dcr-symbol{display:flex;align-items:center;gap:8px;justify-content:space-between}
.dcr-symbol-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.dcr-symbol-count{font-size:10.5px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}

.dcr-graph-empty{display:flex;flex-direction:column;gap:10px;padding:10px 2px}
.dcr-primary{align-self:flex-start;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-brand-primary);border-radius:8px;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;cursor:pointer}
.dcr-primary:disabled{opacity:.6;cursor:default}
.dcr-graph{display:flex;flex-direction:column;gap:8px}
.dcr-graph svg{height:auto;display:block}
.dcr-node{fill:var(--dsw-alias-bg-layer-1);stroke:var(--dsw-alias-border-l2)}
.dcr-node-target{stroke:var(--dsw-alias-brand-primary);stroke-width:1.6}
.dcr-node-def{stroke:var(--dsw-alias-state-success-primary)}
.dcr-node-ref{stroke:var(--dsw-alias-state-warn-primary)}
.dcr-node-label{fill:var(--dsw-alias-label-primary);font-size:11.5px;font-family:inherit}
.dcr-node-sub{fill:var(--dsw-alias-label-secondary);font-size:10px;font-family:inherit}
.dcr-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.2}
.dcr-arrow{fill:var(--dsw-alias-border-l2)}
.dcr-edge-label{fill:var(--dsw-alias-label-secondary);font-size:9.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;paint-order:stroke;stroke:var(--dsw-alias-bg-layer-2);stroke-width:3px;stroke-linejoin:round}
.dcr-graph-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dcr-legend{display:inline-flex;align-items:center;gap:5px}
.dcr-legend::before{content:"";width:9px;height:9px;border-radius:3px;border:1.4px solid var(--dsw-alias-border-l2)}
.dcr-legend-target::before{border-color:var(--dsw-alias-brand-primary)}
.dcr-legend-def::before{border-color:var(--dsw-alias-state-success-primary)}
.dcr-legend-ref::before{border-color:var(--dsw-alias-state-warn-primary)}
.dcr-legend-commit::before{border-color:var(--dsw-alias-label-secondary)}

.dcr-commit-card{display:flex;flex-direction:column;gap:6px;padding:12px 14px;margin:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.dcr-commit-subject{font-size:14px;font-weight:600}
.dcr-commit-meta{display:flex;gap:10px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.dcr-commit-body{margin:0;padding:8px 10px;border-radius:7px;background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;white-space:pre-wrap;max-height:180px;overflow:auto}
.dcr-commit-shortstat{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dcr-commit-files{display:flex;flex-direction:column;gap:2px;padding:0 10px 16px}

.dcr-banner{margin:8px 16px 0;padding:8px 10px;border-radius:7px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.dcr-banner-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dcr-manual{display:flex;align-items:center;gap:8px;padding:8px 16px 0}
.dcr-input{flex:1 1 auto;min-width:0;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.dcr-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dcr-progress{position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,var(--dsw-alias-brand-primary),transparent);animation:dcr-slide 1.1s linear infinite}
@keyframes dcr-slide{0%{opacity:.25}50%{opacity:1}100%{opacity:.25}}
`

    // =====================================================================
    // 插件入口
    // =====================================================================

    /** apply 期间拿到的翻译函数（供非组件代码使用）。 */
    let boundT = (key) => key

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            title: '代码修改审查',
            shortTitle: '版本审查',
            close: '关闭',
            refresh: '刷新',
            repoLabel: '选择仓库',
            noRepo: '没有发现 git 仓库',
            manualRootPlaceholder: '手动输入仓库或工作区路径，例如 C:\\project\\client',
            scan: '扫描',
            tabChanges: '改动',
            tabCommits: '提交',
            tabNotes: '说明',
            tabGraph: '关系图',
            tabAi: 'AI 审查',
            reviewThisFile: '本文件',
            reviewAll: '全部改动',
            startReview: '开始审查',
            rerunReview: '重新审查',
            stopReview: '停止',
            reviewIdle: '让模型用自然语言说明：这次改动做了什么、逻辑是什么、有哪些风险、和同类模块的写法是否一致、是否符合项目 AGENTS.md 与代码自检文档。首次生成大约需要十几秒。',
            reviewModel: '模型',
            reviewFollowDefault: '跟随默认模型',
            reviewPromptChars: '提示词 {n} 字',
            reviewStreaming: '正在生成…',
            reviewThinking: '已推理 {n} 字',
            reviewTruncated: '输出被 token 上限截断，上面是已生成的部分；可换一个模型或只审查更小的范围。',
            reviewFailed: '审查失败',
            reviewRawFallback: '模型返回的内容不是合法 JSON，下面按原文展示。',
            reviewStopped: '已停止，内容可能不完整。',
            secWhat: '做了什么',
            secLogic: '逻辑',
            secDiff: '改动对比',
            secHistory: '历史',
            secHistoryAi: '历史脉络',
            histBefore: '改之前：',
            histContext: '为什么改：',
            hunkCount: '{n} 处',
            autoHunkReview: '悬浮时自动生成每处改动的简评',
            autoHunkReviewHint: '每个文件一次调用，按 diff 缓存；关掉可以省 token，悬浮时只给规则判断。',
            historyEmpty: '这个文件还没有提交历史。',
            binary: '二进制',
            binaryTitle: '这是二进制文件',
            binaryHint: 'git 无法逐行对比。配置类 .bytes 通常是导表产物，要看内容变化请改源表后重新导出。',
            secRisks: '风险',
            secSimilar: '同类模块对比',
            secCompliance: '规约符合度',
            secSuggestions: '建议',
            noRisks: '没有识别出风险。',
            noCompliance: '没有可对照的规约条目。',
            risk_high: '高',
            risk_medium: '中',
            risk_low: '低',
            status_pass: '符合',
            status_warn: '注意',
            status_fail: '不符',
            cleanTree: '工作区干净，没有未提交的改动。',
            unreviewedCount: '未审 {count}',
            filterHint: '只看未审：隐藏已标记审阅的文件，随时可以取消，文件不会真的被删掉',
            allReviewed: '这些改动都标记为已审阅了，取消「未审 0」就能重新看到。',
            markReviewed: '标记为已审阅',
            markUnreviewed: '取消审阅标记',
            resizeLeft: '拖动调整左栏宽度，双击恢复默认',
            resizeRight: '拖动调整右栏宽度，双击恢复默认',
            resizeSplit: '拖动调整左右两版的宽度比例，双击恢复对半',
            pickFile: '在左侧选择一个文件或提交。',
            loading: '加载中…',
            noDiff: '这个文件没有可显示的文本差异（可能是二进制或纯权限变更）。',
            backToCommit: '返回提交详情',
            noMessage: '（无提交说明）',
            justNow: '刚刚',
            minutesAgo: '{n} 分钟前',
            hoursAgo: '{n} 小时前',
            daysAgo: '{n} 天前',
            statLine: '{files} 个改动 · +{added} / -{removed}',
            mode_worktree: '工作区',
            mode_staged: '暂存区',
            mode_head: '相对 HEAD',
            mode_commit: '提交',
            mode_file: '整文件',
            hoverHint: '悬浮查看这一段的审查',
            splitBefore: '基础版本',
            splitAfter: '本地修改',
            tipRange: '从第 {start} 行起',
            tipRangeText: '第 {start}–{end} 行',
            tipScopeLabel: '审查范围',
            tipScope: '本次改动第 {start}–{end} 行（+{added} / -{removed}），是 {total} 处改动里的第 {index} 处，只评价这一段。',
            tipWhat: '这段改了什么',
            tipRisk: '风险',
            tipNoRisk: '这一段没看出明显风险。',
            tipReviewPending: '正在生成简评，先给规则判断…',
            tipDefs: '相关定义',
            tipDefines: '用到的 {name} 定义在这里',
            tipBoundLabel: '绑定',
            tipBoundFiles: '另外 {n} 个文件引用了这段代码：{files}',
            tipBasis: '依据',
            tipReferences: '参考代码',
            tipLogic: '修改逻辑',
            tipBindings: '绑定关系',
            tipFooter: '在 .dsh/code-review.json 补充人工标注可获得更完整的说明。',
            pendingChange: '这些行是工作区里尚未提交的改动。',
            lastFileCommit: '该文件上一次提交',
            noBasis: '暂无提交或标注信息。',
            noReferences: '未找到可参考的同类实现。',
            noBindings: '未找到跨文件引用。',
            analyzing: '正在分析引用…',
            logicStat: '本段新增 {added} 行、删除 {removed} 行，起始于新文件第 {start} 行。',
            logicSymbols: '涉及符号：{names}',
            bindingCount: '{n} 处',
            notesOverview: '概览',
            notesFile: '文件',
            notesHunks: '变更段',
            notesLines: '行数',
            notesAnnotation: '人工标注',
            notesSymbols: '涉及符号',
            notesSymbolsHint: '悬浮任意变更段后，这里会列出该段涉及的符号。',
            annotationMissing: '{file} 没有人工标注条目。',
            annotationNoFile: '仓库里没有标注文件。新建 .dsh/code-review.json 即可补充依据、参考代码与关系图。',
            annotationSource: '标注来源：{path}',
            annotationSourceMissing: '标注文件：.dsh/code-review.json（可选）',
            symbolHits: '{n} 处引用',
            graphHint: '生成关系图需要先扫描本文件改动涉及的符号引用。',
            graphBuild: '生成关系图',
            graphBuilding: '分析中…',
            graphNoData: '没有可绘制的关系。',
            legendTarget: '本次改动',
            legendDef: '定义 / 来源',
            legendRef: '引用方',
            legendCommit: '提交',
            renderFailed: '审查窗口渲染失败：',
          },
          en: {
            title: 'Code change review',
            shortTitle: 'Review',
            close: 'Close',
            refresh: 'Refresh',
            repoLabel: 'Repository',
            noRepo: 'No git repository found',
            manualRootPlaceholder: 'Repository or workspace path, e.g. C:\\project\\client',
            scan: 'Scan',
            tabChanges: 'Changes',
            tabCommits: 'Commits',
            tabNotes: 'Notes',
            tabGraph: 'Graph',
            tabAi: 'AI review',
            reviewThisFile: 'This file',
            reviewAll: 'All changes',
            startReview: 'Start review',
            rerunReview: 'Review again',
            stopReview: 'Stop',
            reviewIdle: 'Ask the model, in plain language, what this change does, how it works, what could go wrong, whether it matches sibling modules, and whether it follows AGENTS.md and the code self-check doc. The first run takes a while.',
            reviewModel: 'Model',
            reviewFollowDefault: 'Follow default model',
            reviewPromptChars: '{n} chars of prompt',
            reviewStreaming: 'Generating…',
            reviewThinking: '{n} chars of reasoning',
            reviewTruncated: 'The output hit the token limit; only the generated part is shown. Try another model or a smaller scope.',
            reviewFailed: 'Review failed',
            reviewRawFallback: 'The model did not return valid JSON; showing the raw text below.',
            reviewStopped: 'Stopped; the result may be incomplete.',
            secWhat: 'What it does',
            secLogic: 'Logic',
            secDiff: 'Code change',
            secHistory: 'History',
            secHistoryAi: 'History',
            histBefore: 'Before: ',
            histContext: 'Why: ',
            hunkCount: '{n} hunks',
            autoHunkReview: 'Generate a short review per hunk on hover',
            autoHunkReviewHint: 'One call per file, cached by diff; turn off to save tokens — hover then shows rule-based notes only.',
            historyEmpty: 'No commit history for this file yet.',
            binary: 'binary',
            binaryTitle: 'Binary file',
            binaryHint: 'git cannot diff this line by line. Config .bytes files are usually export artifacts; edit the source sheet and re-export.',
            secRisks: 'Risks',
            secSimilar: 'Compared with siblings',
            secCompliance: 'Rule compliance',
            secSuggestions: 'Suggestions',
            noRisks: 'No risks identified.',
            noCompliance: 'No applicable rules found.',
            risk_high: 'high',
            risk_medium: 'medium',
            risk_low: 'low',
            status_pass: 'pass',
            status_warn: 'warn',
            status_fail: 'fail',
            cleanTree: 'Working tree is clean.',
            unreviewedCount: '{count} unreviewed',
            filterHint: 'Only unreviewed: hide files you marked as reviewed. Toggle it off to see them again; nothing is deleted.',
            allReviewed: 'Every change here is marked reviewed. Turn off the "0 unreviewed" chip to see them again.',
            markReviewed: 'Mark as reviewed',
            markUnreviewed: 'Clear reviewed mark',
            resizeLeft: 'Drag to resize the file list, double-click to reset',
            resizeRight: 'Drag to resize the side panel, double-click to reset',
            resizeSplit: 'Drag to change the before/after split, double-click to reset',
            pickFile: 'Pick a file or commit on the left.',
            loading: 'Loading…',
            noDiff: 'No textual diff for this file (binary or mode-only change).',
            backToCommit: 'Back to commit',
            noMessage: '(no message)',
            justNow: 'just now',
            minutesAgo: '{n} min ago',
            hoursAgo: '{n} h ago',
            daysAgo: '{n} d ago',
            statLine: '{files} changed · +{added} / -{removed}',
            mode_worktree: 'working tree',
            mode_staged: 'staged',
            mode_head: 'vs HEAD',
            mode_commit: 'commit',
            mode_file: 'whole file',
            hoverHint: 'Hover for a review of this block',
            splitBefore: 'Before',
            splitAfter: 'Local changes',
            tipRange: 'from line {start}',
            tipRangeText: 'lines {start}–{end}',
            tipScopeLabel: 'Review scope',
            tipScope: 'Lines {start}–{end} of this change (+{added} / -{removed}) — hunk {index} of {total}. Only this block is judged.',
            tipWhat: 'What changed here',
            tipRisk: 'Risk',
            tipNoRisk: 'No obvious risk in this block.',
            tipReviewPending: 'Generating a short review; rule-based result shown first…',
            tipDefs: 'Related definitions',
            tipDefines: 'definition of {name}',
            tipBoundLabel: 'Bound to',
            tipBoundFiles: '{n} other files reference this code: {files}',
            tipBasis: 'Basis',
            tipReferences: 'Reference code',
            tipLogic: 'Change logic',
            tipBindings: 'Bindings',
            tipFooter: 'Add manual annotations in .dsh/code-review.json for richer notes.',
            pendingChange: 'These lines are uncommitted working-tree changes.',
            lastFileCommit: 'Last commit touching this file',
            noBasis: 'No commit or annotation information.',
            noReferences: 'No comparable implementation found.',
            noBindings: 'No cross-file references found.',
            analyzing: 'Analysing references…',
            logicStat: 'Adds {added} lines, removes {removed} lines starting at line {start}.',
            logicSymbols: 'Symbols touched: {names}',
            bindingCount: '{n} hits',
            notesOverview: 'Overview',
            notesFile: 'File',
            notesHunks: 'Hunks',
            notesLines: 'Lines',
            notesAnnotation: 'Annotation',
            notesSymbols: 'Symbols',
            notesSymbolsHint: 'Hover a hunk to collect the symbols it touches.',
            annotationMissing: 'No annotation entry for {file}.',
            annotationNoFile: 'No annotation file in this repository. Create .dsh/code-review.json to add basis, references and a diagram.',
            annotationSource: 'Annotation source: {path}',
            annotationSourceMissing: 'Annotation file: .dsh/code-review.json (optional)',
            symbolHits: '{n} hits',
            graphHint: 'Building the graph scans references of the symbols this file touches.',
            graphBuild: 'Build graph',
            graphBuilding: 'Analysing…',
            graphNoData: 'Nothing to draw.',
            legendTarget: 'This change',
            legendDef: 'Definition / source',
            legendRef: 'Referenced by',
            legendCommit: 'Commit',
            renderFailed: 'Review window failed to render: ',
          },
        }), 'dsh-code-review: dictionaries')

        ctx.effect(() => {
          for (const stale of document.querySelectorAll('style[data-plugin-css="dsh-code-review/review.css"]')) stale.remove()
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-code-review'
          tag.dataset.pluginCss = 'dsh-code-review/review.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-code-review: styles')

        try {
          boundT = ctx.locale.bind(NS)
        } catch (error) {
          boundT = (key) => key
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'code-review-launcher', order: 20, locale: NS },
            Launcher,
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'code-review-window', order: 40, locale: NS }, ReviewOverlay),
        )
      },
    }
  },
})
