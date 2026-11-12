/**
 * dsh-code-review — 代码修改审查插件（Host 半区）。
 *
 * 浏览器半区（./client.js）通过 `POST /api/code-review` 调这里的能力：
 *   - 仓库发现、工作区概览（分支 / 领先落后 / 改动清单 / 提交记录）
 *   - 单文件 diff（工作区 / 暂存区 / 某个提交 / 未跟踪新文件）
 *   - 逐行 blame（给悬浮提示提供“这次改动是谁、为什么”的依据）
 *   - 符号级引用扫描（给悬浮提示和关系图提供“和什么有绑定”）
 *   - 人工标注文件（.dsh/code-review.json，补充依据 / 参考代码 / 修改逻辑 / 关系图）
 *
 * 设计约束：
 *   - 只用 `execFile('git', [...])` 起进程，不拼 shell 字符串，参数不经过 shell。
 *   - 所有路径先解析成仓库内相对路径，越界（../）直接拒绝。
 *   - 任何 op 失败都以 `{ error: { code, message } }` 返回，不抛到 HTTP 层。
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export const name = 'dsh-code-diff-review'

/** 请求体上限：diff / 分析请求都很小，4MB 足够。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024
/** git 输出上限：大仓库的 git grep 可能很啰嗦。 */
const GIT_MAX_BUFFER = 32 * 1024 * 1024
/** 普通 git 调用超时。 */
const GIT_TIMEOUT_MS = 25_000
/** 符号扫描超时（大仓库全量 grep 会慢一些）。 */
const GREP_TIMEOUT_MS = 20_000
/** 一次 blame 最多覆盖的行数。 */
const MAX_BLAME_LINES = 500
/** 单个 hunk 最多分析的标识符数量。 */
const MAX_SYMBOLS = 8
/** 单个符号最多保留的命中条数。 */
const MAX_MATCHES_PER_SYMBOL = 60
/** 未跟踪文件合成 diff 时的行数上限。 */
const MAX_SYNTHETIC_LINES = 4000

/** 参与符号扫描时排除的构建产物目录（只影响 grep 的 pathspec，不改仓库内容）。 */
const NOISE_PATHSPECS = ['*/node_modules/*', '*/Library/*', '*/Temp/*', '*/obj/*']

/** 标识符里要丢掉的常见关键字 / 类型名（不是“绑定对象”）。 */
const KEYWORDS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'void', 'class', 'struct',
  'interface', 'enum', 'record', 'delegate', 'namespace', 'return', 'var', 'new',
  'this', 'base', 'null', 'true', 'false', 'if', 'else', 'for', 'foreach', 'while',
  'switch', 'case', 'default', 'break', 'continue', 'using', 'override', 'virtual',
  'abstract', 'sealed', 'readonly', 'const', 'async', 'await', 'try', 'catch',
  'finally', 'throw', 'get', 'set', 'value', 'string', 'int', 'uint', 'float',
  'double', 'bool', 'byte', 'long', 'short', 'object', 'params', 'ref', 'out',
  'typeof', 'sizeof', 'nameof', 'yield', 'partial', 'where', 'select', 'from',
  'let', 'function', 'export', 'import', 'extends', 'implements', 'package',
  'final', 'super', 'instanceof', 'undefined', 'number', 'boolean', 'any',
  'never', 'type', 'declare', 'module', 'require', 'print', 'println', 'endif',
  'define', 'include', 'None', 'self', 'def', 'lambda', 'pass', 'raise', 'with',
  'and', 'or', 'not', 'in', 'is', 'assert', 'global', 'nonlocal', 'elif',
])

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

/** 写一个 JSON 响应。 */
function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** 同源校验：浏览器一定带 Origin；缺失（非浏览器客户端）放行。 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 读请求体为 UTF-8 文本，超过上限直接失败。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true
        data = ''
        return
      }
      if (!tooLarge) data += chunk
    })
    req.on('end', () => (tooLarge ? reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)) : resolve(data)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// git 调用
// ---------------------------------------------------------------------------

/** 解析出可用的 git 可执行文件；Host 进程的 PATH 可能比终端更干净。 */
let gitExecutablePromise
function gitExecutable() {
  if (gitExecutablePromise) return gitExecutablePromise
  const candidates = [
    'git',
    process.env.GIT_EXE,
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs\\Git\\cmd\\git.exe') : undefined,
  ].filter(Boolean)
  gitExecutablePromise = new Promise((resolve) => {
    let index = 0
    const tryNext = () => {
      if (index >= candidates.length) {
        resolve('git')
        return
      }
      const candidate = candidates[index++]
      execFile(candidate, ['--version'], { windowsHide: true, timeout: 8000 }, (error) => {
        if (error && typeof error.code === 'string') tryNext()
        else if (error) tryNext()
        else resolve(candidate)
      })
    }
    tryNext()
  })
  return gitExecutablePromise
}

/**
 * 执行一次 git。退出码非 0 也按正常结果返回（调用方按 code 判断），
 * 只有进程起不来才把 spawnFailed 置真。
 */
async function git(cwd, args, options = {}) {
  const executable = await gitExecutable()
  const timeout = options.timeout ?? GIT_TIMEOUT_MS
  return new Promise((resolve) => {
    execFile(
      executable,
      ['-C', cwd, '-c', 'core.quotepath=false', ...args],
      {
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        timeout,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut: Boolean(error && error.killed),
          spawnFailed: Boolean(error && typeof error.code === 'string'),
        })
      },
    )
  })
}

/** 仓库根目录；不是仓库返回 null。 */
async function repositoryRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null
  const resolved = path.resolve(cwd.trim())
  const info = await stat(resolved).catch(() => null)
  if (!info || !info.isDirectory()) return null
  const result = await git(resolved, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) return null
  const root = result.stdout.trim()
  return root ? path.resolve(root) : null
}

/** 要求 cwd 是一个 git 仓库，否则抛出可读错误。 */
async function requireRepository(cwd) {
  const root = await repositoryRoot(cwd)
  if (!root) throw new Error(`不是 git 仓库：${cwd || '(未指定路径)'}`)
  return root
}

/** 把仓库内相对路径解析成绝对路径，越界即拒绝。 */
function resolveInside(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '') throw new Error('缺少文件路径')
  const absolute = path.resolve(root, relative)
  const rel = path.relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越出仓库：${relative}`)
  return absolute
}

/** 仓库内相对路径（统一成 / 分隔，便于前端比较）。 */
function toRepoPath(root, relative) {
  return path.relative(root, resolveInside(root, relative)).split(path.sep).join('/')
}

async function hasGit(directory) {
  const info = await stat(path.join(directory, '.git')).catch(() => null)
  return Boolean(info)
}

/** Host 侧默认根目录：优先当前会话工作目录。 */
function defaultRoot(ctx) {
  const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  const directory = service && typeof service.defaultDirectory === 'string' ? service.defaultDirectory : ''
  return directory && directory.trim() !== '' ? path.resolve(directory) : process.cwd()
}

/**
 * 候选根目录，按优先级排列。
 *
 * `workingDirectory.defaultDirectory` 指向的是 profile 目录而不是会话工作目录，
 * 所以只靠它必然扫不到仓库；这里把进程目录和用户真正注册过的工作区一起纳入候选，
 * 逐个扫一层，谁先扫到仓库就用谁当默认根。
 */
function candidateRoots(ctx) {
  const roots = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') roots.push(path.resolve(value.trim()))
  }
  push(defaultRoot(ctx))
  push(process.cwd())
  const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry && typeof registry.list === 'function') {
    let workspaces = []
    try {
      workspaces = registry.list() || []
    } catch (error) {
      workspaces = []
    }
    // 最近更新过的工作区排在前面：大概率就是用户正在用的那个
    const ordered = [...workspaces].sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))
    for (const workspace of ordered) push(workspace && workspace.path)
  }
  return Array.from(new Set(roots))
}

/** 扫一个目录：它自己 + 下面一层带 .git 的子目录。 */
async function scanRepos(directory) {
  const repos = []
  const info = await stat(directory).catch(() => null)
  if (!info || !info.isDirectory()) return repos
  if (await hasGit(directory)) repos.push({ name: path.basename(directory) || directory, path: directory })
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const candidate = path.join(directory, entry.name)
    if (await hasGit(candidate)) repos.push({ name: entry.name, path: candidate })
  }
  return repos
}

// ---------------------------------------------------------------------------
// 解析工具
// ---------------------------------------------------------------------------

/** 解析 `git status --porcelain=v1 -z -uall`。 */
function parsePorcelain(raw) {
  const parts = raw.split('\0')
  const entries = []
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i]
    if (!item) continue
    const x = item[0] || ' '
    const y = item[1] || ' '
    const file = item.slice(3)
    if (!file) continue
    let original = ''
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      original = parts[i + 1] || ''
      i += 1
    }
    entries.push({ path: file, originalPath: original, x, y, untracked: x === '?' })
  }
  return entries
}

/** 解析 `git diff --numstat`。 */
function parseNumstat(raw) {
  const map = new Map()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? null : Number(parts[0])
    const removed = parts[1] === '-' ? null : Number(parts[1])
    let file = parts.slice(2).join('\t')
    const arrow = file.lastIndexOf(' => ')
    if (arrow !== -1) file = file.slice(arrow + 4).replace(/^\{|\}$/g, '')
    map.set(file, { added, removed, binary: added === null })
  }
  return map
}

/** 解析 `git log --pretty=format:...%x1f...`。 */
function parseLog(raw) {
  const commits = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [hash, short, author, email, date, subject] = line.split('\x1f')
    if (!hash) continue
    commits.push({ hash, short: short || hash.slice(0, 8), author: author || '', email: email || '', date: date || '', subject: subject || '' })
  }
  return commits
}

/** 解析 `git blame --line-porcelain`。 */
function parseBlame(raw) {
  const lines = []
  let current = null
  for (const line of raw.split('\n')) {
    if (/^[0-9a-f]{40} /.test(line)) {
      const parts = line.split(' ')
      current = { hash: parts[0], short: parts[0].slice(0, 8), line: Number(parts[2]) || 0, author: '', date: '', summary: '' }
      lines.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\t')) {
      current = null
      continue
    }
    if (line.startsWith('author ')) current.author = line.slice(7)
    else if (line.startsWith('author-time ')) {
      const seconds = Number(line.slice(12))
      if (Number.isFinite(seconds)) current.date = new Date(seconds * 1000).toISOString()
    } else if (line.startsWith('summary ')) current.summary = line.slice(8)
  }
  return lines
}

/** 解析 `git grep -n` 输出为 { path, line, text }。 */
function parseGrep(raw) {
  const matches = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    // 仓库里的文件常是 CRLF，grep 会把行尾的 \r 一起带出来
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    const match = /^(.+?):(\d+):(.*)$/.exec(trimmed)
    if (!match) continue
    matches.push({ path: match[1], line: Number(match[2]) || 0, text: match[3] })
  }
  return matches
}

/** 把行号数组压成连续区间。 */
function compressRanges(numbers) {
  const sorted = [...new Set(numbers.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
  const ranges = []
  for (const value of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && value === last[1] + 1) last[1] = value
    else ranges.push([value, value])
  }
  return ranges
}

/** 判断某个匹配行更像“定义/声明”还是“引用”。 */
function looksLikeDeclaration(text, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(`\\b(class|interface|enum|struct|record|delegate|namespace|def|function|func|type|const|let|var)\\s+${escaped}\\b`)
  const method = new RegExp(`\\b${escaped}\\s*\\(`)
  const modifier = /\b(public|private|protected|internal|static|abstract|virtual|override|async|final|sealed|partial)\b/
  return declaration.test(text) || (method.test(text) && modifier.test(text))
}

/**
 * 从源码行里抽候选标识符。
 *
 * 会先剔掉“本段自己声明的局部变量”（`int serverX = ...` / `var trapCfg = ...`）：
 * 它们的同名命中几乎都是别的函数里的同名字段，对“和什么有绑定”没有解释力。
 */
function extractIdentifiers(content, ranges) {
  const lines = content.split('\n')
  const localNames = new Set()
  const identifiers = []
  const seen = new Set()

  const declaration = /(?:^|[\s,(])(?:var|int|uint|float|double|long|short|byte|bool|string|char|decimal|[A-Z][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g

  for (const [start, end] of ranges) {
    const last = Math.min(end, lines.length)
    for (let index = start; index <= last; index += 1) {
      const raw = lines[index - 1] || ''
      for (const match of raw.matchAll(declaration)) localNames.add(match[1])
    }
  }

  for (const [start, end] of ranges) {
    const last = Math.min(end, lines.length)
    for (let index = start; index <= last; index += 1) {
      const raw = lines[index - 1] || ''
      const stripped = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
      for (const match of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
        const word = match[0]
        if (KEYWORDS.has(word) || localNames.has(word) || seen.has(word)) continue
        seen.add(word)
        identifiers.push(word)
        if (identifiers.length >= MAX_SYMBOLS) return identifiers
      }
    }
  }
  return identifiers
}

/** 为一个未跟踪/无差异文件合成统一 diff，前端只处理一种格式。 */
async function syntheticNewFileDiff(root, relative) {
  const absolute = resolveInside(root, relative)
  let content = ''
  try {
    content = await readFile(absolute, 'utf8')
  } catch (error) {
    return `# 无法读取文件：${error.message}\n`
  }
  if (content.includes('\u0000')) return `# 二进制文件，未生成文本差异\n`
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const capped = lines.slice(0, MAX_SYNTHETIC_LINES)
  const head = [
    `diff --git a/${relative} b/${relative}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relative}`,
    `@@ -0,0 +1,${capped.length} @@`,
  ]
  const body = capped.map((line) => `+${line}`)
  if (lines.length > capped.length) body.push(`+... 已截断，共 ${lines.length} 行`)
  return `${head.join('\n')}\n${body.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// 各项能力
// ---------------------------------------------------------------------------

/** 发现根目录下（含自身）的 git 仓库；不指定根时把候选目录都扫一遍。 */
async function opRepos(payload, ctx) {
  const requested = typeof payload.root === 'string' && payload.root.trim() !== '' ? path.resolve(payload.root.trim()) : ''
  if (requested) {
    const info = await stat(requested).catch(() => null)
    if (!info || !info.isDirectory()) throw new Error(`目录不存在：${requested}`)
    const found = await orderByRecentActivity(await scanRepos(requested))
    return withSessionContext(ctx, { root: requested, repos: found, scanned: [requested] }, found)
  }

  const roots = candidateRoots(ctx)
  const repos = []
  const seen = new Set()
  let root = ''
  for (const directory of roots) {
    const found = await scanRepos(directory)
    if (found.length && root === '') root = directory
    for (const repo of found) {
      const key = repo.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      repos.push(repo)
    }
  }
  const ordered = await orderByRecentActivity(repos)
  return withSessionContext(ctx, { root: root || roots[0] || process.cwd(), repos: ordered, scanned: roots }, ordered)
}

/**
 * 把「当前会话在哪」一并回给前端，用来决定打开窗口时默认选哪个仓库。
 * 会话目录可能本身就是仓库，也可能是多仓根目录，两种情况前端都要能处理。
 */
function withSessionContext(ctx, result, repos) {
  const context = collectSessionContext(ctx, repos)
  result.sessionDirs = context.dirs
  result.sessionRepos = context.repos
  return result
}

/** 取某个 live session 的有效工作目录。 */
function sessionDirectory(session, workingDirectory) {
  try {
    if (workingDirectory) {
      const current = workingDirectory.get(session)
      if (typeof current === 'string' && current) return current
    }
  } catch (error) {
    /* 会话已被回收，退回创建时的目录 */
  }
  const header = session && session.header
  return header && typeof header.cwd === 'string' ? header.cwd : ''
}

/** 会话最后一条事件的时间，用来判断「哪个会话是当前正在用的」。 */
function sessionLastActivity(session) {
  try {
    const seq = Number(session.seq)
    if (!seq) return 0
    const tail = session.snapshotEvents(Math.max(0, seq - 1))
    const event = tail && tail.length ? tail[tail.length - 1] : null
    return event && typeof event.time === 'number' ? event.time : 0
  } catch (error) {
    return 0
  }
}

/**
 * 汇总 live session 的工作目录，以及这些会话最近在工具调用里碰过的仓库。
 * 只取根会话（子代理会话的目录不代表用户在哪），按最后活动时间倒序。
 */
function collectSessionContext(ctx, repos) {
  const result = { dirs: [], repos: [] }
  let sessions = []
  try {
    const store = ctx.get('sessions')
    if (store && typeof store.list === 'function') sessions = store.list()
  } catch (error) {
    return result
  }
  if (!Array.isArray(sessions) || sessions.length === 0) return result

  const roots = sessions.filter((session) => {
    const header = session && session.header
    if (!header) return false
    if (header.parentSession) return false
    if (header.origin === 'subagent') return false
    return true
  })
  if (roots.length === 0) return result

  const decorated = roots.map((session) => ({
    session: session,
    active: sessionLastActivity(session),
    created: (session.header && session.header.createdAt) || 0,
  }))
  decorated.sort((left, right) => right.active - left.active || right.created - left.created)
  const ordered = decorated.map((item) => item.session)

  let workingDirectory
  try {
    workingDirectory = ctx.get('workingDirectory')
  } catch (error) {
    workingDirectory = undefined
  }

  const seenDirs = new Set()
  for (const session of ordered) {
    const directory = sessionDirectory(session, workingDirectory)
    if (!directory) continue
    const key = directory.toLowerCase()
    if (seenDirs.has(key)) continue
    seenDirs.add(key)
    if (result.dirs.length < 8) result.dirs.push(directory)
  }

  const paths = repos.map((repo) => repo.path)
  if (!paths.length) return result
  // 工具参数是 JSON 字符串，Windows 路径在里面是转义过的（\\），正斜杠也要认
  const needles = []
  for (const repoPath of paths) {
    const variants = [repoPath, repoPath.replace(/\\/g, '\\\\'), repoPath.replace(/\\/g, '/')]
    for (const variant of variants) {
      const needle = variant.toLowerCase()
      if (needles.some((item) => item.path === repoPath && item.needle === needle)) continue
      needles.push({ path: repoPath, needle: needle })
    }
  }
  const counts = new Map()

  // 只看当前（最后活动）那个会话的尾部事件：别的会话会把结果带偏
  for (const session of ordered.slice(0, 1)) {
    let events = []
    try {
      const tail = Math.max(0, Number(session.seq) - 240)
      events = session.snapshotEvents(tail) || []
    } catch (error) {
      events = []
    }
    for (const event of events) {
      if (!event || event.type !== 'tool/call') continue
      const args = event.data && typeof event.data.arguments === 'string' ? event.data.arguments : ''
      if (!args) continue
      const haystack = args.toLowerCase()
      // 一次调用只算最深的那个仓库，否则父目录会被重复计数
      let best = null
      for (const item of needles) {
        if (haystack.indexOf(item.needle) < 0) continue
        if (!best || item.needle.length > best.needle.length) best = item
      }
      if (!best) continue
      counts.set(best.path, (counts.get(best.path) || 0) + 1)
    }
  }

  result.repos = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map((entry) => entry[0])
  return result
}

/**
 * 按「最近在这个仓库里跑过 git」排序：`.git/index` 的 mtime 会随 status/diff 刷新，
 * 于是用户常用的那个仓库自然浮到第一位，下拉框默认值也更可能是想要的。
 */
async function orderByRecentActivity(repos) {
  const decorated = await Promise.all(
    repos.map(async (repo) => {
      const info = await stat(path.join(repo.path, '.git', 'index')).catch(() => null)
      return { repo, time: info ? info.mtimeMs : 0 }
    }),
  )
  decorated.sort((a, b) => b.time - a.time || a.repo.name.localeCompare(b.repo.name))
  return decorated.map((item) => item.repo)
}

/** 工作区概览：分支、领先落后、改动清单、最近提交。 */
async function opOverview(payload) {
  const root = await requireRepository(payload.cwd)
  const branchResult = await git(root, ['symbolic-ref', '--short', 'HEAD'])
  const detached = branchResult.code !== 0
  let branch = branchResult.stdout.trim()
  if (detached) {
    const head = await git(root, ['rev-parse', '--short', 'HEAD'])
    branch = head.stdout.trim() || '(无提交)'
  }
  const upstreamResult = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  let upstream = ''
  let ahead = 0
  let behind = 0
  if (upstreamResult.code === 0) {
    upstream = upstreamResult.stdout.trim()
    const counts = await git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])
    if (counts.code === 0) {
      const [b, a] = counts.stdout.trim().split(/\s+/)
      behind = Number(b) || 0
      ahead = Number(a) || 0
    }
  }
  const statusResult = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const status = parsePorcelain(statusResult.stdout)
  const unstaged = parseNumstat((await git(root, ['diff', '--numstat'])).stdout)
  const staged = parseNumstat((await git(root, ['diff', '--cached', '--numstat'])).stdout)
  for (const entry of status) {
    const lineStat = unstaged.get(entry.path) || staged.get(entry.path) || null
    entry.added = lineStat ? lineStat.added : null
    entry.removed = lineStat ? lineStat.removed : null
    entry.binary = lineStat ? Boolean(lineStat.binary) : false
  }
  const commits = parseLog((await git(root, ['log', '-n', '40', '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s'])).stdout)
  const added = status.reduce((sum, entry) => sum + (entry.added || 0), 0)
  const removed = status.reduce((sum, entry) => sum + (entry.removed || 0), 0)
  return { root, branch, detached, upstream, ahead, behind, status, commits, totals: { files: status.length, added, removed } }
}

/** 单文件差异。 */
/** 二进制文件没法逐行对比，至少给出改前改后的大小。 */
async function describeBinary(root, relative, rev) {
  const before = await git(root, ['cat-file', '-s', `${rev || 'HEAD'}:${relative}`])
  const afterInfo = await stat(resolveInside(root, relative)).catch(() => null)
  return {
    binary: true,
    beforeBytes: before.code === 0 ? Number(before.stdout.trim()) || null : null,
    afterBytes: afterInfo ? afterInfo.size : null,
  }
}

/** 判断 diff 文本是不是“二进制文件”占位。 */
function looksBinary(diffText) {
  return /^Binary files .* differ$/m.test(diffText) || /^GIT binary patch$/m.test(diffText)
}

async function opDiff(payload) {
  const root = await requireRepository(payload.cwd)
  const relative = toRepoPath(root, payload.path)
  const mode = typeof payload.mode === 'string' ? payload.mode : 'auto'
  const diffArgs = (extra) => ['diff', '--no-color', '--no-ext-diff', '-U3', ...extra, '--', relative]

  if (mode === 'commit') {
    if (typeof payload.rev !== 'string' || !payload.rev.trim()) throw new Error('缺少提交号')
    const result = await git(root, ['show', '--no-color', '--no-ext-diff', '--format=', '-U3', payload.rev.trim(), '--', relative])
    const extra = looksBinary(result.stdout) ? await describeBinary(root, relative, `${payload.rev.trim()}~1`) : null
    return { path: relative, mode: 'commit', text: result.stdout, ...(extra || {}) }
  }
  if (mode === 'staged') {
    const result = await git(root, diffArgs(['--cached']))
    const extra = looksBinary(result.stdout) ? await describeBinary(root, relative) : null
    return { path: relative, mode: 'staged', text: result.stdout, ...(extra || {}) }
  }
  if (mode === 'file') {
    return { path: relative, mode: 'file', text: await syntheticNewFileDiff(root, relative) }
  }

  const worktree = await git(root, diffArgs([]))
  if (worktree.stdout.trim()) {
    const extra = looksBinary(worktree.stdout) ? await describeBinary(root, relative) : null
    return { path: relative, mode: 'worktree', text: worktree.stdout, ...(extra || {}) }
  }
  const staged = await git(root, diffArgs(['--cached']))
  if (staged.stdout.trim()) {
    const extra = looksBinary(staged.stdout) ? await describeBinary(root, relative) : null
    return { path: relative, mode: 'staged', text: staged.stdout, ...(extra || {}) }
  }
  const againstHead = await git(root, diffArgs(['HEAD']))
  if (againstHead.stdout.trim()) {
    const extra = looksBinary(againstHead.stdout) ? await describeBinary(root, relative) : null
    return { path: relative, mode: 'head', text: againstHead.stdout, ...(extra || {}) }
  }
  return { path: relative, mode: 'file', text: await syntheticNewFileDiff(root, relative) }
}

/** 逐行 blame（只取关心的行段，避免整文件扫描）。 */
async function opBlame(payload) {
  const root = await requireRepository(payload.cwd)
  const relative = toRepoPath(root, payload.path)
  const start = Math.max(1, Math.floor(Number(payload.start) || 1))
  const requestedEnd = Math.floor(Number(payload.end) || start)
  const end = Math.min(Math.max(start, requestedEnd), start + MAX_BLAME_LINES - 1)
  const result = await git(root, ['blame', '--line-porcelain', '-L', `${start},${end}`, '--', relative])
  if (result.code !== 0) {
    return { lines: [], error: result.stderr.trim() || '该行段无法 blame（可能是新文件或二进制）' }
  }
  const lines = parseBlame(result.stdout)
  // 工作区里还没提交的行，blame 会给出全 0 的伪提交；这时补一次“该文件上一次提交”，
  // 悬浮提示才有真正可用的依据。
  const pending = lines.some((line) => /^0+$/.test(line.hash))
  let fileCommit = null
  if (pending) {
    const last = await git(root, ['log', '-1', '--date=iso-strict', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--', relative])
    if (last.code === 0 && last.stdout.trim()) {
      const [short, author, date, ...rest] = last.stdout.trim().split('\x1f')
      fileCommit = { short, author, date, summary: rest.join('\x1f') }
    }
  }
  for (const line of lines) {
    if (/^0+$/.test(line.hash)) {
      line.pending = true
      line.author = ''
      line.summary = ''
    }
  }
  return { lines, pending, fileCommit }
}

/** 符号扫描：给悬浮提示的“参考代码 / 绑定关系”供数。 */
async function opAnalyze(payload) {
  const root = await requireRepository(payload.cwd)
  const relative = toRepoPath(root, payload.path)
  const ranges = Array.isArray(payload.ranges) ? payload.ranges : []
  return analyzeSymbols(root, relative, ranges, payload.rev)
}

/**
 * 符号扫描本体：抽出改动行的标识符，去同扩展名文件里找定义与引用。
 * @param {string} root 仓库根
 * @param {string} relative 仓库内相对路径
 * @param {Array<[number, number]>} ranges 关心的行区间
 * @param {string} [rev] 给了提交号就从该提交里取内容
 */
async function analyzeSymbols(root, relative, ranges, rev) {
  let content = ''
  if (typeof rev === 'string' && rev.trim() !== '') {
    const result = await git(root, ['show', `${rev.trim()}:${relative}`])
    if (result.code !== 0) return { symbols: [], error: '该提交里读不到此文件' }
    content = result.stdout
  } else {
    content = await readFile(resolveInside(root, relative), 'utf8').catch(() => '')
  }
  if (!content) return { symbols: [], error: '读不到文件内容' }
  const identifiers = extractIdentifiers(content, ranges)
  if (identifiers.length === 0) return { symbols: [], empty: true }

  // 只扫同一种扩展名：整个仓库全类型扫描在大型 Unity / Java 工程上要 8~10 秒，
  // 单扩展名通常 1 秒以内，而且跨语言的“引用”本来也不是有效绑定。
  const extension = path.extname(relative).toLowerCase()
  const pathspecs = [extension ? `*${extension}` : `${path.posix.dirname(relative)}/*`]
  for (const noise of NOISE_PATHSPECS) pathspecs.push(`:(exclude)${noise}`)

  const args = ['grep', '-n', '-w', '-I', '--no-color', '--full-name']
  for (const identifier of identifiers) args.push('-e', identifier)
  args.push('--', ...pathspecs)
  const grepResult = await git(root, args, { timeout: GREP_TIMEOUT_MS })
  const matches = parseGrep(grepResult.stdout)

  // 每个符号预编译一次正则：命中行可能有上万条，逐行重建 RegExp 会拖到秒级。
  const symbols = identifiers.map((name) => ({
    name: name,
    defs: [],
    refs: [],
    total: 0,
    truncated: false,
    matcher: new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
  }))
  const seen = new Set()
  for (const match of matches) {
    for (const symbol of symbols) {
      if (!symbol.matcher.test(match.text)) continue
      const dedupeKey = `${symbol.name}|${match.path}|${match.line}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      const item = { path: match.path, line: match.line, text: match.text.trim().slice(0, 240), target: match.path === relative }
      if (looksLikeDeclaration(match.text, symbol.name)) {
        if (symbol.defs.length < MAX_MATCHES_PER_SYMBOL) symbol.defs.push(item)
      } else if (symbol.refs.length < MAX_MATCHES_PER_SYMBOL) {
        symbol.refs.push(item)
      }
      symbol.total += 1
    }
  }
  for (const symbol of symbols) {
    if (symbol.total > symbol.defs.length + symbol.refs.length) symbol.truncated = true
    delete symbol.matcher
    // 排序分数：有跨文件定义、本文件里也在用、引用面别太散 → 更像真正的“绑定”。
    const externalDefs = symbol.defs.filter((item) => !item.target).length
    const targetRefs = symbol.refs.filter((item) => item.target).length
    const externalFiles = new Set(symbol.refs.filter((item) => !item.target).map((item) => item.path)).size
    symbol.score =
      (externalDefs > 0 ? 3 : 0) +
      (targetRefs > 0 ? 2 : 0) +
      Math.min(3, externalFiles) -
      Math.min(4, Math.log10(Math.max(1, symbol.total)))
  }
  symbols.sort((a, b) => b.score - a.score)
  return {
    symbols: symbols.filter((symbol) => symbol.total > 0),
    truncated: grepResult.timedOut,
    note: grepResult.timedOut ? '符号扫描超时，结果可能不完整' : '',
  }
}

/** 提交详情。 */
async function opCommit(payload) {
  const root = await requireRepository(payload.cwd)
  const rev = typeof payload.rev === 'string' && payload.rev.trim() !== '' ? payload.rev.trim() : 'HEAD'
  const meta = await git(root, ['show', '-s', '--date=iso-strict', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%B', rev])
  if (meta.code !== 0) throw new Error(meta.stderr.trim() || `读不到提交 ${rev}`)
  const [hash, short, author, email, date, ...rest] = meta.stdout.split('\x1f')
  const message = rest.join('\x1f').trim()
  const nameStatus = await git(root, ['show', '--name-status', '--format=', rev])
  const files = []
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    files.push({ status: parts[0], path: parts.slice(1).join('\t') })
  }
  const shortstat = await git(root, ['show', '--shortstat', '--format=', rev])
  return { hash, short, author, email, date, message, files, shortstat: shortstat.stdout.trim() }
}

/** 人工标注文件。 */
async function opAnnotations(payload) {
  const root = await requireRepository(payload.cwd)
  const candidates = ['.dsh/code-review.json', 'code-review.json', '.dsh-review.json']
  for (const relative of candidates) {
    const absolute = path.join(root, relative)
    const info = await stat(absolute).catch(() => null)
    if (!info || !info.isFile()) continue
    const raw = await readFile(absolute, 'utf8')
    try {
      const document = JSON.parse(raw)
      const entries = Array.isArray(document) ? document : Array.isArray(document.entries) ? document.entries : []
      return { source: relative, entries, version: document.version || 1 }
    } catch (error) {
      return { source: relative, entries: [], error: `标注文件解析失败：${error.message}` }
    }
  }
  return { source: '', entries: [] }
}

/** 从统一 diff 里取新增行的行号区间。 */
function addedLineRanges(diffText) {
  const added = []
  let newLine = 0
  for (const raw of String(diffText || '').split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
    if (match) {
      newLine = Number(match[1])
      continue
    }
    if (!newLine) continue
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      added.push(newLine)
      newLine += 1
    } else if (raw.startsWith('-')) {
      // 删除行只影响旧文件行号
    } else {
      newLine += 1
    }
  }
  return compressRanges(added)
}

/**
 * 自然语言审查（SSE 流式）。
 *
 * 组装「规约 + diff + 上下文 + 同类模块 + 符号引用 + 最近提交」，交给 llm 服务流式生成，
 * 边生成边把 text-delta 推给浏览器。
 */
async function handleReview(req, res, ctx) {
  if (req.method !== 'POST') {
    respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST required' } })
    return
  }
  if (!sameOrigin(req)) {
    respond(res, 403, { error: { code: 'cross-origin', message: '拒绝跨源请求' } })
    return
  }

  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (error) {
    respond(res, 400, { error: { code: 'invalid-body', message: String(error.message || error) } })
    return
  }

  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') {
    respond(res, 503, { error: { code: 'llm-unavailable', message: 'LLM 服务不可用' } })
    return
  }

  let root
  let model
  let prompt
  let meta = {}
  try {
    root = await requireRepository(payload.cwd)
    model = resolveReviewModel(ctx, payload)
    const mode = payload.mode === 'all' ? 'all' : 'file'
    const branchResult = await git(root, ['symbolic-ref', '--short', 'HEAD'])
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : '(detached)'
    const rules = await collectRules(root)

    let diff = ''
    let diffTruncated = false
    let untracked = []
    let code = { excerpt: '', excerptTruncated: false, siblings: [], recentCommits: [] }
    let symbols = []
    let target = ''
    let status = ''

    if (mode === 'all') {
      const collected = await collectAllDiffs(root)
      diff = collected.diff
      diffTruncated = collected.truncated
      untracked = collected.untracked
      const statusResult = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
      status = statusResult.stdout.trim() ? '有未提交改动' : '工作区干净'
    } else {
      target = toRepoPath(root, payload.path)
      const diffResult = await opDiff({ cwd: root, path: target, mode: 'auto' })
      diff = diffResult.text
      const clipped = clipText(diff, REVIEW_MAX_DIFF)
      diff = clipped.text
      diffTruncated = clipped.truncated
      const ranges = addedLineRanges(diffResult.text)
      code = await collectCodeContext(root, target, ranges, payload.rev)
      code.outlines = await collectSiblingOutlines(root, code.siblings)
      symbols = await collectSymbols(root, target, ranges, payload.rev)
      const entry = (await opOverview({ cwd: root })).status.find((item) => item.path === target)
      status = entry ? `${entry.untracked ? '新增' : '修改'}（${entry.x}${entry.y}）` : ''
    }

    prompt = buildReviewPrompt({
      repoName: path.basename(root),
      branch,
      target,
      status,
      diff,
      diffTruncated,
      untracked,
      rules,
      code,
      symbols,
      mode,
    })
    meta = { mode, target, provider: model.provider, model: model.model, promptChars: prompt.length }
  } catch (error) {
    respond(res, 400, { error: { code: 'review-failed', message: String(error.message || error) } })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders?.()

  const controller = new AbortController()
  let closed = false
  req.on('close', () => {
    closed = true
    controller.abort()
  })
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS)
  const send = (event, data) => {
    if (closed || res.writableEnded) return
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch (error) {
      closed = true
    }
  }

  send('start', meta)
  let text = ''
  let thinking = ''
  const kinds = {}
  let usage = null
  let truncated = false
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: REVIEW_MAX_TOKENS,
      signal: controller.signal,
    })) {
      kinds[chunk.type] = (kinds[chunk.type] || 0) + 1
      if (chunk.type === 'text-delta') {
        text += chunk.text
        send('delta', { text: chunk.text })
      } else if (chunk.type === 'reasoning-delta') {
        // 推理模型的思考过程：单独推给前端，既能让用户看到进度，也方便排查“只思考不回答”
        thinking += chunk.text
        send('thinking', { text: chunk.text })
      } else if (chunk.type === 'usage') {
        usage = chunk.usage
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind === 'error') {
          send('error', { message: chunk.reason.failure?.message || '模型调用失败' })
        } else if (chunk.reason.kind === 'aborted') {
          send('error', { message: '已中止' })
        } else if (chunk.reason.kind === 'max-tokens') {
          truncated = true
          if (!text.trim()) send('error', { message: '输出被 token 上限截断（模型把额度用在了推理上），请换一个模型或重试' })
        }
      }
    }
    send('done', { text, chars: text.length, thinkingChars: thinking.length, usage, kinds, truncated })
  } catch (error) {
    send('error', { message: String((error && error.message) || error) })
  } finally {
    clearTimeout(timer)
    if (!res.writableEnded) res.end()
  }
}

/** 单个文件的提交历史：给“历史是什么样”供数。 */
async function opHistory(payload) {
  const root = await requireRepository(payload.cwd)
  const relative = payload.path ? toRepoPath(root, payload.path) : ''
  const limit = Math.min(40, Math.max(1, Number(payload.limit) || 12))
  const args = ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s']
  if (relative) args.push('--', relative)
  const result = await git(root, args)
  if (result.code !== 0) throw new Error(result.stderr.trim() || '读不到提交历史')
  const commits = parseLog(result.stdout)
  // 每条提交对这个文件的增删行数
  if (relative && commits.length) {
    const numstat = await git(root, ['log', `-${limit}`, '--numstat', '--format=%x1e%H', '--', relative])
    if (numstat.code === 0) {
      const byHash = new Map()
      let current = ''
      for (const line of numstat.stdout.split('\n')) {
        if (line.startsWith('\x1e')) {
          current = line.slice(1).trim()
          continue
        }
        const parts = line.split('\t')
        if (parts.length < 3 || !current) continue
        const added = parts[0] === '-' ? null : Number(parts[0])
        const removed = parts[1] === '-' ? null : Number(parts[1])
        byHash.set(current, { added, removed })
      }
      for (const commit of commits) {
        const stat = byHash.get(commit.hash)
        commit.added = stat ? stat.added : null
        commit.removed = stat ? stat.removed : null
      }
    }
  }
  return { path: relative, commits }
}

// ---------------------------------------------------------------------------
// 单块简评：给悬浮提示用的“这一处改动在干什么”
// ---------------------------------------------------------------------------

/** 简评的 token 上限：只要一两句话。 */
const HUNK_MAX_TOKENS = 1_200
/** 简评的整体超时。 */
const HUNK_TIMEOUT_MS = 60_000

/** 简评的系统提示词。 */
const HUNK_SYSTEM = `你是资深代码审查者。用户会给你一个文件里的若干处代码改动（unified diff 片段）。
对每一处改动，用简体中文给出：
1. what：这一处改动具体做了什么（一句话，不超过 60 字，说清“从什么变成什么”）。
2. risk：这一处的风险（不超过 60 字；没有风险就给空字符串，不要凑）。
只依据给出的片段，不要推测片段外的代码。只输出 JSON 数组，不要代码围栏。`

/** 把一处 hunk 转成给模型看的紧凑文本。 */
function formatHunkForReview(hunk) {
  const rows = Array.isArray(hunk.rows) ? hunk.rows : []
  const lines = rows.slice(0, 60).map((row) => {
    const sign = row.t === '+' || row.t === '-' ? row.t : ' '
    return `${sign}${String(row.text || '').slice(0, 200)}`
  })
  return `@@ ${hunk.header || ''}\n${lines.join('\n')}`
}

/** 一次为多个 hunk 生成简评。 */
async function opHunkReview(payload, ctx) {
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm || typeof llm.stream !== 'function') throw new Error('LLM 服务不可用')
  const hunks = Array.isArray(payload.hunks) ? payload.hunks.slice(0, 8) : []
  if (!hunks.length) return { reviews: [] }
  const model = resolveReviewModel(ctx, payload)

  const body = hunks
    .map((hunk, index) => `## 第 ${index + 1} 处（编号 ${index}）\n\`\`\`diff\n${formatHunkForReview(hunk)}\n\`\`\``)
    .join('\n\n')

  const prompt = `文件：${payload.path || '(未知)'}

${body}

请按顺序输出 JSON 数组，每项形如：
{"i": 编号, "what": "这一处做了什么", "risk": "风险，没有就空字符串"}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HUNK_TIMEOUT_MS)
  let text = ''
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      system: HUNK_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: HUNK_MAX_TOKENS,
      signal: controller.signal,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || '模型调用失败')
      }
    }
  } finally {
    clearTimeout(timer)
  }

  let parsed = null
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/, '').replace(/```$/, '')
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1))
    } catch (error) {
      parsed = null
    }
  }
  const reviews = Array.isArray(parsed)
    ? parsed
        .filter((item) => item && typeof item.i === 'number')
        .map((item) => ({
          index: item.i,
          what: typeof item.what === 'string' ? item.what : '',
          risk: typeof item.risk === 'string' ? item.risk : '',
        }))
    : []
  return { reviews, provider: model.provider, model: model.model, raw: reviews.length ? '' : String(text || '').slice(0, 400) }
}

/** op 路由表。 */
const OPERATIONS = {
  repos: opRepos,
  overview: opOverview,
  diff: opDiff,
  blame: opBlame,
  analyze: opAnalyze,
  commit: opCommit,
  annotations: opAnnotations,
  models: opModels,
  history: opHistory,
  hunkReview: opHunkReview,
}

// ---------------------------------------------------------------------------
// 自然语言审查：素材收集
// ---------------------------------------------------------------------------

/** 送进模型的 diff 字符上限。 */
const REVIEW_MAX_DIFF = 14_000
/** 送进模型的源码上下文上限。 */
const REVIEW_MAX_CODE = 9_000
/** 送进模型的规约文档总上限。 */
const REVIEW_MAX_RULES = 11_000
/** 单份规约文档上限。 */
const REVIEW_RULE_FILE_CAP = 7_000
/** 审查输出上限：推理模型会先消耗推理 token，留足余量。 */
const REVIEW_MAX_TOKENS = 16_000
/** 单次审查的整体超时。 */
const REVIEW_TIMEOUT_MS = 180_000

/** 规约文档缓存：30 秒内不重复读盘。 */
const rulesCache = new Map()

/** 模型目录缓存。 */
let modelCatalogCache = { at: 0, value: null }

/** 按字符数截断，并给出是否截断。 */
function clipText(text, limit) {
  const value = String(text || '')
  if (value.length <= limit) return { text: value, truncated: false }
  return { text: value.slice(0, limit), truncated: true }
}

/**
 * 收集项目规约：仓库 / 工作区 AGENTS.md，以及开启开关时的代码自检文档。
 * 这些是审查“是否符合项目要求”的唯一依据。
 */
async function collectRules(root) {
  const cached = rulesCache.get(root)
  if (cached && Date.now() - cached.at < 30_000) return cached.value

  const documents = []
  const candidates = [
    { file: path.join(root, 'AGENTS.md'), label: '仓库 AGENTS.md' },
    { file: path.join(path.dirname(root), 'AGENTS.md'), label: '工作区 AGENTS.md' },
  ]

  // 代码自检：只有开关为 true 时才把正文送进去
  let selfCheckEnabled = null
  try {
    const raw = await readFile(path.join(root, 'agent扩充功能开关.json'), 'utf8')
    const parsed = JSON.parse(raw)
    selfCheckEnabled = parsed && parsed.enabled === true
  } catch (error) {
    selfCheckEnabled = null
  }
  if (selfCheckEnabled === true) {
    candidates.push({ file: path.join(root, '代码自检文档.md'), label: '代码自检文档.md' })
  }

  let budget = REVIEW_MAX_RULES
  for (const candidate of candidates) {
    if (budget <= 0) break
    const info = await stat(candidate.file).catch(() => null)
    if (!info || !info.isFile()) continue
    const raw = await readFile(candidate.file, 'utf8').catch(() => '')
    if (!raw) continue
    const clipped = clipText(raw, Math.min(REVIEW_RULE_FILE_CAP, budget))
    budget -= clipped.text.length
    documents.push({
      label: candidate.label,
      text: clipped.text,
      truncated: clipped.truncated,
    })
  }

  const value = { documents, selfCheckEnabled }
  rulesCache.set(root, { at: Date.now(), value })
  return value
}

/** 读取代码上下文：改动处附近的源码 + 同目录相似模块 + 最近提交。 */
async function collectCodeContext(root, relative, ranges, rev) {
  let content = ''
  if (typeof rev === 'string' && rev.trim() !== '') {
    const shown = await git(root, ['show', `${rev.trim()}:${relative}`])
    if (shown.code === 0) content = shown.stdout
  } else {
    content = await readFile(resolveInside(root, relative), 'utf8').catch(() => '')
  }

  let excerpt = ''
  let excerptTruncated = false
  if (content) {
    const lines = content.split('\n')
    if (lines.length <= 420) {
      const clipped = clipText(content, REVIEW_MAX_CODE)
      excerpt = clipped.text
      excerptTruncated = clipped.truncated
    } else {
      // 大文件只送改动段前后 25 行
      const windows = []
      for (const [start, end] of ranges.length ? ranges : [[1, 60]]) {
        windows.push([Math.max(1, start - 25), Math.min(lines.length, end + 25)])
      }
      windows.sort((a, b) => a[0] - b[0])
      const merged = []
      for (const window of windows) {
        const last = merged[merged.length - 1]
        if (last && window[0] <= last[1] + 5) last[1] = Math.max(last[1], window[1])
        else merged.push([...window])
      }
      const parts = []
      let used = 0
      for (const [start, end] of merged) {
        const block = lines.slice(start - 1, end).map((line, index) => `${start + index}| ${line}`).join('\n')
        if (used + block.length > REVIEW_MAX_CODE) {
          // 单个窗口就超预算时也要截一段出来，否则上下文整段丢失
          const remaining = REVIEW_MAX_CODE - used
          if (remaining > 400) {
            parts.push(`--- 第 ${start}-${end} 行（已截断） ---\n${block.slice(0, remaining)}`)
          }
          excerptTruncated = true
          break
        }
        used += block.length
        parts.push(`--- 第 ${start}-${end} 行 ---\n${block}`)
      }
      excerpt = parts.join('\n\n')
    }
  }

  // 同目录里同扩展名的兄弟文件：判断“有没有采用相似写法”的参照
  const directory = path.posix.dirname(relative)
  const extension = path.extname(relative)
  const siblings = []
  const siblingDir = path.join(root, directory === '.' ? '' : directory)
  const entries = await readdir(siblingDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(extension) || entry.name.endsWith('.meta')) continue
    const sibling = directory === '.' ? entry.name : `${directory}/${entry.name}`
    if (sibling === relative) continue
    siblings.push(sibling)
    if (siblings.length >= 12) break
  }

  // 最近改动这个文件的提交
  const logResult = await git(root, ['log', '-5', '--date=short', '--pretty=format:%h %an %ad %s', '--', relative])
  const recentCommits = logResult.code === 0 ? logResult.stdout.split('\n').filter(Boolean) : []

  return { excerpt, excerptTruncated, siblings, recentCommits, content }
}

/** 同类模块摘要：只取声明行，够模型判断“写法是否一致”又不吃预算。 */
const SIBLING_OUTLINE_FILES = 3
const SIBLING_OUTLINE_LINES = 20
const SIBLING_OUTLINE_CHARS = 1_400

/**
 * 抽取同目录同类模块的「写法摘要」：类声明、字段、方法签名。
 * 没有这份材料，模型只能回答“无同类可参照”。
 */
async function collectSiblingOutlines(root, siblings) {
  const outlines = []
  for (const sibling of siblings.slice(0, SIBLING_OUTLINE_FILES)) {
    const absolute = path.join(root, ...sibling.split('/'))
    const raw = await readFile(absolute, 'utf8').catch(() => '')
    if (!raw) continue
    const picked = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const isDeclaration =
        /^(public|private|protected|internal)\b/.test(trimmed) ||
        /^(class|struct|interface|enum)\b/.test(trimmed) ||
        /^\s*(\[|#region)/.test(line)
      if (!isDeclaration) continue
      if (trimmed.length > 160) continue
      picked.push(line.trimEnd())
      if (picked.length >= SIBLING_OUTLINE_LINES) break
    }
    if (!picked.length) continue
    outlines.push({ path: sibling, text: clipText(picked.join('\n'), SIBLING_OUTLINE_CHARS).text })
  }
  return outlines
}

/** 整个工作区的改动（审查全部改动时用）。 */
async function collectAllDiffs(root) {
  const worktree = await git(root, ['diff', '--no-color', '--no-ext-diff', '-U2'])
  const staged = await git(root, ['diff', '--cached', '--no-color', '--no-ext-diff', '-U2'])
  const statusResult = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  const untracked = statusResult.stdout
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))

  const combined = [worktree.stdout, staged.stdout].filter((part) => part.trim()).join('\n')
  const clipped = clipText(combined, REVIEW_MAX_DIFF)
  return {
    diff: clipped.text,
    truncated: clipped.truncated,
    untracked: untracked.slice(0, 40),
  }
}

/** 符号级引用，作为“和什么有绑定 / 有没有类似实现”的素材。 */
async function collectSymbols(root, relative, ranges, rev) {
  try {
    const result = await analyzeSymbols(root, relative, ranges, rev)
    return result.symbols || []
  } catch (error) {
    return []
  }
}

/** 审查用的系统提示词。 */
const REVIEW_SYSTEM = `你是一位资深代码审查者，同时熟悉 Unity 客户端（C#/HybridCLR）与 Java 服务端（Netty/Protobuf/MongoDB）。
你在审查一次真实的代码修改，必须只依据给出的材料下结论，不要臆测材料里没有的代码。

输出要求：
- 用简体中文。
- 只输出一个 JSON 对象，不要 markdown 代码围栏，不要前后解释。
- 结论要能指到具体文件与行号；没有依据的地方写“材料不足”，不要编造。
- 风险按严重度排序；没有风险就返回空数组，不要凑数。
- 对照规约时逐条给结论，规约里没写的不要当成违规。`

/** 审查输出的 JSON 结构（写进提示词）。 */
const REVIEW_SCHEMA = `{
  "summary": "一句话说清这次改动做了什么（不超过 100 字）",
  "what": ["具体做了什么，最多 5 条，每条不超过 80 字"],
  "logic": ["关键逻辑与数据流，最多 5 条，每条不超过 120 字"],
  "history": {
    "before": "改动之前这里是什么实现（不超过 150 字，没有历史依据就写“材料不足”）",
    "context": "这次改动是在什么背景下发生的（不超过 150 字）"
  },
  "risks": [
    { "level": "high|medium|low", "title": "风险点（不超过 30 字）", "detail": "为什么是风险、什么情况下会出问题（不超过 200 字）", "where": "文件:行号" }
  ],
  "similar": {
    "verdict": "一致 | 部分一致 | 不一致 | 无同类可参照",
    "detail": "与同类模块的写法差异（不超过 150 字）",
    "peers": [ { "path": "同类模块路径", "note": "它怎么写的、本次差异在哪（不超过 80 字）" } ]
  },
  "compliance": [
    { "rule": "规约条目（不超过 40 字）", "source": "AGENTS.md / 代码自检文档.md 的哪一节", "status": "pass|warn|fail", "detail": "本次改动是否满足，依据是什么（不超过 150 字）" }
  ],
  "suggestions": ["可执行的修改建议，最多 5 条，每条不超过 100 字"]
}`

/** 组装审查提示词。 */
function buildReviewPrompt(input) {
  const { repoName, branch, target, status, diff, diffTruncated, untracked, rules, code, symbols, mode } = input
  const blocks = []

  blocks.push(`# 审查对象
- 仓库：${repoName}
- 分支：${branch}
- 范围：${mode === 'all' ? '工作区全部未提交改动' : `单个文件 ${target}`}
${status ? `- 文件状态：${status}` : ''}`)

  if (rules.documents.length) {
    blocks.push(`# 项目规约（必须逐条对照）
${rules.selfCheckEnabled === false ? '> 注意：本仓库 agent 扩充功能开关为 false，代码自检文档不执行。\n' : ''}
${rules.documents
  .map((document) => `## ${document.label}${document.truncated ? '（已截断）' : ''}\n\`\`\`\n${document.text}\n\`\`\``)
  .join('\n\n')}`)
  } else {
    blocks.push('# 项目规约\n没有找到 AGENTS.md / 代码自检文档，compliance 一栏请说明“无规约可对照”。')
  }

  blocks.push(`# 本次改动 diff${diffTruncated ? '（已截断）' : ''}
\`\`\`diff
${diff || '（没有文本差异）'}
\`\`\``)

  if (untracked && untracked.length) {
    blocks.push(`# 未跟踪的新文件（未包含内容）
${untracked.map((file) => `- ${file}`).join('\n')}`)
  }

  if (code.excerpt) {
    blocks.push(`# 改动处上下文${code.excerptTruncated ? '（已截断）' : ''}
\`\`\`
${code.excerpt}
\`\`\``)
  }

  if (code.siblings.length) {
    blocks.push(`# 同目录下的同类模块（判断写法是否一致的参照）
${code.siblings.map((file) => `- ${file}`).join('\n')}`)
  }

  if (code.outlines && code.outlines.length) {
    blocks.push(`# 同类模块的写法摘要（对比是否采用相似写法时以这里为准）
${code.outlines.map((outline) => `## ${outline.path}\n\`\`\`\n${outline.text}\n\`\`\``).join('\n\n')}`)
  }

  if (symbols.length) {
    const lines = []
    for (const symbol of symbols.slice(0, 6)) {
      const definition = (symbol.defs || []).find((item) => !item.target) || (symbol.refs || []).find((item) => !item.target)
      if (!definition) continue
      lines.push(`- 符号 \`${symbol.name}\`（共 ${symbol.total} 处引用）→ ${definition.path}:${definition.line}  ${String(definition.text || '').trim().slice(0, 120)}`)
    }
    if (lines.length) blocks.push(`# 这些符号还被谁用到（判断影响面与绑定关系）\n${lines.join('\n')}`)
  }

  if (code.recentCommits.length) {
    blocks.push(`# 最近改动该文件的提交
${code.recentCommits.map((line) => `- ${line}`).join('\n')}`)
  }

  blocks.push(`# 请输出
严格按下面的 JSON 结构回答：
${REVIEW_SCHEMA}`)

  return blocks.join('\n\n')
}

/** 从 agent 默认模型或请求参数里确定审查用的 provider / model。 */
function resolveReviewModel(ctx, payload) {
  const provider = typeof payload.provider === 'string' ? payload.provider.trim() : ''
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (provider && model) return { provider, model, source: 'explicit' }
  const service = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
  let selection = null
  try {
    selection = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
  } catch (error) {
    selection = null
  }
  if (!selection || !selection.provider || !selection.model) throw new Error('无法确定默认模型，请先在设置里选一个模型')
  return { provider: selection.provider, model: selection.model, source: 'default' }
}

/** 可用模型目录（给审查面板的模型下拉框）。 */
async function opModels(payload, ctx) {
  if (modelCatalogCache.value && Date.now() - modelCatalogCache.at < 300_000) return modelCatalogCache.value
  const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  if (!llm) return { providers: [], error: 'LLM 服务不可用' }
  const providers = []
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      const listed = await llm.listModels(provider.id)
      models = (listed || []).map((model) => ({ id: model.id, name: model.name || model.id }))
    } catch (error) {
      models = []
    }
    providers.push({ id: provider.id, name: provider.name || provider.id, models })
  }
  let current = null
  try {
    const service = ctx.get('agentDefaultModel')
    current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
  } catch (error) {
    current = null
  }
  const value = { providers, current }
  modelCatalogCache = { at: Date.now(), value }
  return value
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: '/api/code-review',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST required' } })
              return
            }
            if (!sameOrigin(req)) {
              respond(res, 403, { error: { code: 'cross-origin', message: '拒绝跨源请求' } })
              return
            }
            let payload
            try {
              payload = JSON.parse(await readBody(req))
            } catch (error) {
              respond(res, 400, { error: { code: 'invalid-body', message: String(error.message || error) } })
              return
            }
            const op = payload && typeof payload.op === 'string' ? payload.op : ''
            const operation = OPERATIONS[op]
            if (!operation) {
              respond(res, 400, { error: { code: 'unknown-op', message: `未知操作：${op || '(空)'}` } })
              return
            }
            try {
              respond(res, 200, await operation(payload, ctx))
            } catch (error) {
              const message = String((error && error.message) || error)
              ctx.logger?.warn?.(`dsh-code-review: ${op} 失败：${message}`)
              respond(res, 400, { error: { code: 'operation-failed', message } })
            }
          },
        }),
      'dsh-code-review: /api/code-review',
    )

    // 自然语言审查走独立路由：SSE 流式，不能用上面那个 JSON 通道
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'exact',
          path: '/api/code-review/review',
          handler: (req, res) => handleReview(req, res, ctx),
        }),
      'dsh-code-review: /api/code-review/review',
    )
  })
}