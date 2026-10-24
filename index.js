/**
 * 写书（writebook）—— Host 半边。
 *
 * 只做一件事：把工作区的 books/ 目录开成一个 HTTP 接口，给面板用。
 * 目录约定和 tools/写书 一致：
 *   books/<书>/书.json
 *   books/<书>/01_世界观.md ...
 *   books/<书>/正文/第001章_名字.md
 *
 * 路由 /writebook-api：
 *   GET  /books                       书架
 *   GET  /book?dir=名                 一本书：封面信息 + 设定文件 + 章节目录
 *   GET  /file?dir=名&path=相对路径    读一份文件（章节 / 设定）
 *   POST /file                        保存一份文件（带 mtime 冲突检查）
 *   POST /chapter/new                 新建一章
 *   POST /book/new                    新建一本书
 *
 * 根目录：config.root；缺省用当前会话默认工作区的 books/。
 */

import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'writebook'
export const inject = ['webServer', 'tools']

const ROUTE = '/writebook-api'
const MAX_BODY = 16 * 1024 * 1024

/** 字数：只数汉字（和 tools/写书 一致）。 */
const han = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length

const isPlainName = (n) =>
  typeof n === 'string' && n.length > 0 && n.length < 120 && !/[\\/]/.test(n) && n !== '.' && n !== '..'

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('内容太大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** 把 rel 解析到 base 里面；越界返回 null。 */
function inside(base, rel) {
  const root = path.resolve(base)
  const target = path.resolve(root, rel)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return target
}

const chapterNo = (file) => Number((file.match(/第(\d+)章/) || [])[1] || 0)

function firstHeading(raw, fallback) {
  const m = raw.match(/^#\s*(.+)$/m)
  return m ? m[1].trim() : fallback
}

function readMeta(bookDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(bookDir, '书.json'), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function listChapters(bookDir) {
  const dir = path.join(bookDir, '正文')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .sort((a, b) => chapterNo(a) - chapterNo(b) || a.localeCompare(b))
    .map((file) => {
      const abs = path.join(dir, file)
      const raw = fs.readFileSync(abs, 'utf8')
      const body = raw.replace(/^#\s*[^\n]*\n?/, '')
      return {
        file,
        path: `正文/${file}`,
        n: chapterNo(file),
        title: firstHeading(raw, file.replace(/\.md$/, '')),
        chars: han(body),
        mtime: fs.statSync(abs).mtimeMs,
      }
    })
}

function listSettings(bookDir) {
  if (!fs.existsSync(bookDir)) return []
  return fs
    .readdirSync(bookDir)
    .filter((f) => f.endsWith('.md') && /^\d+_/.test(f))
    .sort()
    .map((file) => {
      const abs = path.join(bookDir, file)
      const raw = fs.readFileSync(abs, 'utf8')
      return { file, path: file, title: firstHeading(raw, file.replace(/\.md$/, '')), chars: han(raw) }
    })
}

function summarizeBook(root, dir) {
  const bookDir = path.join(root, dir)
  const meta = readMeta(bookDir)
  const chapters = listChapters(bookDir)
  return {
    dir,
    title: meta.书名 || dir,
    type: meta.类型 || '',
    status: meta.状态 || '',
    volume: meta.卷 || '',
    oneLine: meta.一句话 || '',
    note: meta.备注 || '',
    chapters: chapters.length,
    chars: chapters.reduce((sum, c) => sum + c.chars, 0),
    updated: chapters.reduce((max, c) => Math.max(max, c.mtime), 0),
  }
}

function listBooks(root) {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'))
    .map((entry) => summarizeBook(root, entry.name))
    .sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title))
}

function bookDetail(root, dir) {
  const bookDir = path.join(root, dir)
  if (!fs.existsSync(bookDir)) throw Object.assign(new Error(`没有这本书：${dir}`), { status: 404 })
  return {
    book: summarizeBook(root, dir),
    settings: listSettings(bookDir),
    chapters: listChapters(bookDir),
  }
}

function readFile(root, dir, rel) {
  const bookDir = path.join(root, dir)
  const abs = inside(bookDir, rel)
  if (!abs) throw Object.assign(new Error('路径越界'), { status: 400 })
  let raw
  try {
    raw = fs.readFileSync(abs, 'utf8')
  } catch {
    throw Object.assign(new Error(`读不到：${rel}`), { status: 404 })
  }
  const stat = fs.statSync(abs)
  return {
    dir,
    path: rel,
    title: firstHeading(raw, path.basename(rel, '.md')),
    raw,
    chars: han(raw.replace(/^#\s*[^\n]*\n?/, '')),
    mtime: stat.mtimeMs,
  }
}

/**
 * 写之前留一份底。
 *
 * 只留 **最近 3 份历史备份** —— 加上现件就是「当前 + 上一步 + 上上步 + 上上上步」，
 * 往回退三步。第四份起当场删掉，文件名里带时间戳，按名排序就是时间序。
 * 备份失败不挡保存。
 */
function pruneBackups(dir, prefix) {
  let names
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
      .sort()
      .reverse()
  } catch {
    return
  }
  for (const name of names.slice(3)) {
    try {
      fs.unlinkSync(path.join(dir, name))
    } catch {
      /* 删不掉就先留着，下次再说 */
    }
  }
}

function backupBeforeWrite(bookDir, abs) {
  try {
    const rel = path.relative(bookDir, abs).replace(/[\\/]/g, '_')
    const dir = path.join(bookDir, '.backups')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    fs.copyFileSync(abs, path.join(dir, `${rel}.${stamp}.bak`))
    pruneBackups(dir, `${rel}.`)
  } catch {
    /* 备份失败就算了，不能因为这挡住保存 */
  }
}

function writeFile(root, dir, rel, raw, expectedMtime) {
  const bookDir = path.join(root, dir)
  const abs = inside(bookDir, rel)
  if (!abs) throw Object.assign(new Error('路径越界'), { status: 400 })
  if (typeof raw !== 'string') throw Object.assign(new Error('缺少内容'), { status: 400 })
  let mtime = 0
  let before = ''
  try {
    mtime = fs.statSync(abs).mtimeMs
    before = fs.readFileSync(abs, 'utf8')
  } catch {
    throw Object.assign(new Error(`没有这个文件：${rel}`), { status: 404 })
  }
  // 前端拿到的版本和磁盘对不上 = 这期间有人（或 agent）改过，别硬盖。
  if (typeof expectedMtime === 'number' && Math.abs(mtime - expectedMtime) > 1) {
    throw Object.assign(new Error('文件已被改动，请先刷新再保存'), {
      status: 409,
      conflict: true,
      mtime,
    })
  }
  if (before !== raw) backupBeforeWrite(bookDir, abs)
  fs.writeFileSync(abs, raw, 'utf8')
  return {
    dir,
    path: rel,
    title: firstHeading(raw, path.basename(rel, '.md')),
    raw,
    chars: han(raw.replace(/^#\s*[^\n]*\n?/, '')),
    mtime: fs.statSync(abs).mtimeMs,
  }
}

function newChapter(root, dir, title, n) {
  const bookDir = path.join(root, dir)
  if (!fs.existsSync(bookDir)) throw Object.assign(new Error(`没有这本书：${dir}`), { status: 404 })
  const textDir = path.join(bookDir, '正文')
  fs.mkdirSync(textDir, { recursive: true })
  const chapters = listChapters(bookDir)
  const no = Number.isFinite(n) && n > 0 ? n : chapters.reduce((max, c) => Math.max(max, c.n), 0) + 1
  const clean = String(title || '').replace(/[\\/:*?"<>|]/g, '').trim() || '未命名'
  const file = `第${String(no).padStart(3, '0')}章_${clean}.md`
  const abs = path.join(textDir, file)
  if (fs.existsSync(abs)) throw Object.assign(new Error(`已经有这一章：${file}`), { status: 409 })
  const raw = `# 第${no}章 ${clean}\n\n`
  fs.writeFileSync(abs, raw, 'utf8')
  return { file, path: `正文/${file}`, n: no, title: `第${no}章 ${clean}`, raw, chars: 0, mtime: fs.statSync(abs).mtimeMs }
}

function newBook(root, title, type, oneLine) {
  const clean = String(title || '').replace(/[\\/:*?"<>|]/g, '').trim()
  if (!clean) throw Object.assign(new Error('书名不能为空'), { status: 400 })
  fs.mkdirSync(root, { recursive: true })
  const bookDir = path.join(root, clean)
  if (fs.existsSync(bookDir)) throw Object.assign(new Error(`已经有这本书：${clean}`), { status: 409 })
  fs.mkdirSync(path.join(bookDir, '正文'), { recursive: true })
  const meta = { 书名: clean, 类型: type || '', 状态: '构思中', 一句话: oneLine || '', 卷: '' }
  fs.writeFileSync(path.join(bookDir, '书.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
  return summarizeBook(root, clean)
}

// ─── 写书经验卡 ──────────────────────────────────────────────
// 存的是**写小说这件事本身**的经验，跨书通用（开局怎么写、对话怎么收、
// 节奏怎么排），不绑某一本书 —— 一本书的规矩留在书自己的设定文件里。
// 位置跟心情插件的 procedures/ 是同一套：工作区下（books/ 的上一级），
// 头部 `> **症状**：…` 是下次用来搜的词，`> **场景**：…` 是分组用的。

const notesDir = (root) => path.join(path.dirname(root), 'procedures')

function listNotes(root) {
  const dir = notesDir(root)
  if (!fs.existsSync(dir)) return { dir, cards: [], inbox: 0 }
  const cards = []
  let inbox = 0
  try {
    const inb = path.join(dir, '_inbox.md')
    if (fs.existsSync(inb)) {
      inbox = fs
        .readFileSync(inb, 'utf8')
        .split('\n')
        .filter((line) => line.trim() && !line.trim().startsWith('#')).length
    }
  } catch {
    /* 读不动就当 0 */
  }
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('_') || /^INDEX\.md$/i.test(name)) continue
    // 这个面板只管写小说的经验；别的场景（做插件、修工具……）的卡不进来，
    // 它们在同一个目录里，mood 的面板照样看得到。
    if (!name.startsWith('写书-')) continue
    const abs = path.join(dir, name)
    let text = ''
    try {
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const head = text.split('\n').slice(0, 10).join('\n')
    const symptom =
      head.match(/^\s*>\s*\*\*症状\*\*[：:]\s*(.+)$/m) || head.match(/^\s*>\s*\*\*触发\*\*[：:]\s*(.+)$/m)
    const sceneHit = head.match(/^\s*>\s*\*\*场景\*\*[：:]\s*(.+)$/m)
    const stat = fs.statSync(abs)
    cards.push({
      id: name,
      name: name.replace(/\.md$/, ''),
      trigger: symptom ? symptom[1].trim() : name.replace(/\.md$/, ''),
      scene: sceneHit ? sceneHit[1].trim() : '',
      mtime: stat.mtimeMs,
      bytes: stat.size,
    })
  }
  cards.sort((a, b) => b.mtime - a.mtime)
  return { dir, cards, inbox }
}

function readNote(root, id) {
  const dir = notesDir(root)
  const safe = path.basename(String(id || '').replace(/[\\/]/g, ''))
  if (!safe.endsWith('.md')) throw Object.assign(new Error('只能读 .md'), { status: 400 })
  const abs = path.join(dir, safe)
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`没有这张卡：${safe}`), { status: 404 })
  const raw = fs.readFileSync(abs, 'utf8')
  return { id: safe, raw, mtime: fs.statSync(abs).mtimeMs, dir }
}

function writeNote(root, body) {
  const dir = notesDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const clean = String(body.title || body.symptom || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 40)
  if (!clean) throw Object.assign(new Error('总得有个名字'), { status: 400 })
  const file = clean.startsWith('写书-') ? `${clean}.md` : `写书-${clean}.md`
  const day = new Date().toISOString().slice(0, 10)
  const scene = String(body.scene || '').trim() || '未分类'
  const text = [
    `# ${clean}`,
    '',
    `> **症状**：${String(body.symptom || clean).trim()}`,
    `> **场景**：${scene}`,
    `> **来源**：写书插件 · ${day}`,
    '',
    '## 解法',
    String(body.fix || '').trim() || '（还没写）',
    '',
    '## 什么时候不适用',
    String(body.unless || '').trim() || '（未标）',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, file), text, 'utf8')
  return { id: file, dir }
}

function appendInbox(root, line) {
  const dir = notesDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, '_inbox.md')
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '# inbox —— 踩坑当下记一行，别等收尾\n\n', 'utf8')
  const text = String(line || '').trim()
  if (!text) throw Object.assign(new Error('空的'), { status: 400 })
  fs.appendFileSync(abs, `- ${text}\n`, 'utf8')
  return { dir }
}

// ─── 这一章之前该看什么 ─────────────────────────────────────
// 长程崩不是「忘了怎么写」，是**早期埋的东西到后面没人翻**。所以把三样
// 自动捞到正文旁边：上一章结尾、这一章该埋/该收的伏笔、检查表头几条。

function chapterContext(root, dir, rel) {
  const bookDir = path.join(root, dir)
  const chapters = listChapters(bookDir)
  const index = chapters.findIndex((c) => c.path === rel)
  const current = index >= 0 ? chapters[index] : null
  const n = current ? current.n : 0

  let prev = null
  if (index > 0) {
    const before = chapters[index - 1]
    try {
      const raw = fs.readFileSync(path.join(bookDir, '正文', before.file), 'utf8')
      const body = raw.replace(/^#\s*[^\n]*\n?/, '').trim()
      prev = { title: before.title, n: before.n, tail: body.slice(-520) }
    } catch {
      /* 读不到就算了 */
    }
  }

  const issues = []
  const table = path.join(bookDir, '05_伏笔表.md')
  if (n && fs.existsSync(table)) {
    const chapterOf = (cell) => {
      const m = String(cell || '').match(/第\s*(\d+)\s*章/)
      return m ? Number(m[1]) : 0
    }
    try {
      for (const line of fs.readFileSync(table, 'utf8').split('\n')) {
        if (!line.trim().startsWith('|')) continue
        const cells = line.split('|').map((s) => s.trim())
        if (cells.length < 6) continue
        const no = cells[1]
        if (!/^\d+$/.test(no)) continue
        const name = cells[2]
        if (chapterOf(cells[3]) === n) issues.push({ no: Number(no), name, kind: '埋', where: cells[3] })
        if (chapterOf(cells[4]) === n) issues.push({ no: Number(no), name, kind: '收', where: cells[4] })
      }
    } catch {
      /* 表坏了就当没有 */
    }
  }

  return { n, prev, issues }
}



// ─── 现在写的是哪本 ─────────────────────────────────────────
// 落盘在工作区根的 .writebook.json 里（不在任何一本书里）。
// 面板用它高亮书架，agent 用 writebook 工具读它 —— 同一个值，两边不会打架。

const stateFile = (root) => path.join(path.dirname(root), '.writebook.json')

function readState(root) {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function writeState(root, patch) {
  const next = { ...readState(root), ...patch }
  try {
    fs.writeFileSync(stateFile(root), JSON.stringify(next, null, 2) + '\n', 'utf8')
  } catch {
    /* 写不了就当没设过 */
  }
  return next
}

export function apply(ctx, config) {
  const hasBooks = (dir) => {
    try {
      if (!fs.existsSync(dir)) return false
      return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory())
    } catch {
      return false
    }
  }

  const resolveRoot = () => {
    if (config && typeof config.root === 'string' && config.root.trim()) return path.resolve(config.root)
    const candidates = []
    // 工作区里带 books/ 且有书的那个 —— 这就是写书工作区。
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry && typeof registry.list === 'function') {
        for (const workspace of registry.list()) {
          if (workspace && typeof workspace.path === 'string' && workspace.path) {
            candidates.push(path.join(workspace.path, 'books'))
          }
        }
      }
    } catch {
      /* 没有工作区登记表就退下一条 */
    }
    try {
      const wd = ctx.get('workingDirectory')
      if (wd && typeof wd.defaultDirectory === 'string' && wd.defaultDirectory) {
        candidates.push(path.join(wd.defaultDirectory, 'books'))
      }
    } catch {
      /* 退到进程目录 */
    }
    candidates.push(path.join(process.cwd(), 'books'))
    return candidates.find((candidate) => hasBooks(candidate)) || candidates[0]
  }

  const fail = (res, error) => {
    const status = error && error.status ? error.status : 500
    json(res, status, {
      error: error && error.message ? error.message : String(error),
      ...(error && error.conflict ? { conflict: true, mtime: error.mtime } : {}),
    })
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://writebook.local')
    const route = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
    const root = resolveRoot()
    const dir = url.searchParams.get('dir') || ''
    const rel = url.searchParams.get('path') || ''

    try {
      if (req.method === 'GET') {
        if (route === '/books') return json(res, 200, { root, current: readState(root).current || '', books: listBooks(root) })
        if (route === '/book') {
          if (!isPlainName(dir)) throw Object.assign(new Error('缺少书名'), { status: 400 })
          return json(res, 200, bookDetail(root, dir))
        }
        if (route === '/file') {
          if (!isPlainName(dir) || !rel) throw Object.assign(new Error('缺少参数'), { status: 400 })
          return json(res, 200, readFile(root, dir, rel))
        }
        if (route === '/notes') return json(res, 200, listNotes(root, url.searchParams.get('book') || ''))
        if (route === '/note') return json(res, 200, readNote(root, url.searchParams.get('id') || ''))
        if (route === '/context') {
          if (!isPlainName(dir) || !rel) throw Object.assign(new Error('缺少参数'), { status: 400 })
          return json(res, 200, chapterContext(root, dir, rel))
        }
        throw Object.assign(new Error('没有这个接口'), { status: 404 })
      }

      if (req.method === 'POST') {
        const body = await readBody(req)
        // POST 的 dir 可能走查询串，也可能在 JSON body 里（面板就是后者）。
        const postDir = isPlainName(dir) ? dir : isPlainName(body && body.dir) ? body.dir : ''
        if (route === '/file') {
          if (!isPlainName(postDir) || !body.path) throw Object.assign(new Error('缺少参数'), { status: 400 })
          const saved = writeFile(root, postDir, body.path, body.raw, body.mtime)
          return json(res, 200, { ok: true, file: saved })
        }
        if (route === '/chapter/new') {
          if (!isPlainName(postDir)) throw Object.assign(new Error('缺少书名'), { status: 400 })
          const created = newChapter(root, postDir, body.title, body.n)
          return json(res, 200, { ok: true, chapter: created })
        }
        if (route === '/book/new') {
          const book = newBook(root, body.title, body.type, body.oneLine)
          return json(res, 200, { ok: true, book })
        }
        if (route === '/note') return json(res, 200, { ok: true, ...writeNote(root, body) })
        if (route === '/current') {
          const name = String(body.dir || '').trim()
          const books = listBooks(root)
          if (!books.some((b) => b.dir === name)) {
            throw Object.assign(new Error(`没有这本书：${name || '（空）'}`), { status: 404 })
          }
          writeState(root, { current: name })
          return json(res, 200, { ok: true, current: name })
        }
        if (route === '/inbox') return json(res, 200, { ok: true, ...appendInbox(root, body.line) })
        throw Object.assign(new Error('没有这个接口'), { status: 404 })
      }

      json(res, 405, { error: '不支持的方法' })
    } catch (error) {
      fail(res, error)
    }
  }

  const server = ctx.webServer ?? ctx.get('webServer')
  if (!server || typeof server.register !== 'function') {
    console.warn('[writebook] 没有 webServer，接口没挂上（面板会一直转圈）')
    return
  }
  ctx.effect(() => server.register({ kind: 'prefix', path: ROUTE, handler }))
  console.log(`[writebook] ${ROUTE} → ${resolveRoot()}`)

  // 给 agent 的那个入口：写书前先问一句「现在是哪本」。
  ctx.tools.register(
    defineTool({
      name: 'writebook',
      description:
        '写小说项目：当前是哪本书、写到哪一章、有哪些设定文件。' +
        '**接到写书、改章节、查设定、续写这类任务时，先调一次 action=current**，别猜是哪本。' +
        'action=list 列出全部书；action=set 切换当前书（book 传 books/ 下的文件夹名）。' +
        '数据来自 books/ 目录，和写书面板是同一份。',
      parameters: {
        action: { type: 'string', description: 'current（默认）/ list / set' },
        book: { type: 'string', description: 'action=set 时的书名（books/ 下的文件夹名）' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: String(value && value.message ? value.message : '') }],
      },
      async execute(args) {
        const root = resolveRoot()
        const books = listBooks(root)
        const state = readState(root)
        const action = String((args && args.action) || 'current').trim() || 'current'

        if (action === 'set') {
          const name = String((args && args.book) || '').trim()
          const hit = books.find((b) => b.dir === name || b.title === name)
          if (!hit) {
            return {
              ok: false,
              message: `没有这本书：${name || '（空）'}。现有：${
                books.map((b) => b.dir).join('、') || '（书架是空的）'
              }`,
            }
          }
          writeState(root, { current: hit.dir })
          return {
            ok: true,
            current: hit.dir,
            message: `当前写书项目切到《${hit.title}》（${hit.chapters} 章 / ${hit.chars} 字）`,
          }
        }

        if (action === 'list') {
          const current = state.current || (books[0] && books[0].dir) || ''
          return {
            ok: true,
            current,
            books: books.map((b) => ({ dir: b.dir, title: b.title, chapters: b.chapters, chars: b.chars })),
            message:
              books
                .map((b) => `${b.dir === current ? '→ ' : '  '}${b.dir}（${b.chapters} 章 / ${b.chars} 字）`)
                .join('\n') || '（书架是空的）',
          }
        }

        const current = books.find((b) => b.dir === state.current) || books[0]
        if (!current) return { ok: false, message: '书架是空的（books/ 下没有书）。' }
        const detail = bookDetail(root, current.dir)
        const last = detail.chapters[detail.chapters.length - 1]
        return {
          ok: true,
          book: current.dir,
          root,
          chapters: detail.chapters.map((c) => ({ n: c.n, title: c.title, chars: c.chars })),
          message: [
            `当前写书项目：《${current.title}》（${current.dir}）${current.type ? ` · ${current.type}` : ''}`,
            `${detail.chapters.length} 章 / ${current.chars} 字`,
            last ? `写到：${last.title}（${last.chars} 字）` : '正文还没有',
            `设定：${detail.settings.map((s) => s.file).join('、') || '（无）'}`,
            `根目录：${root}`,
          ].join('\n'),
        }
      },
    }),
  )
}
