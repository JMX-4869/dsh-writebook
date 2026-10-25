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

/** 点开头的目录/文件（.backups、.writebook.json）不是正文，面板不给开读写。 */
function assertReadableRel(rel) {
  if (/(^|[\\/])\./.test(String(rel || ''))) {
    throw Object.assign(new Error('隐藏目录不开放读写'), { status: 400 })
  }
}

function readFile(root, dir, rel) {
  const bookDir = path.join(root, dir)
  const abs = inside(bookDir, rel)
  if (!abs) throw Object.assign(new Error('路径越界'), { status: 400 })
  assertReadableRel(rel)
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
  assertReadableRel(rel)
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
  // 空标题不许建 —— 否则误点一下就在正文里留一个「第004章_未命名.md」。
  const clean = String(title || '').replace(/[\\/:*?"<>|]/g, '').trim()
  if (!clean) throw Object.assign(new Error('给这一章起个名字再建'), { status: 400 })
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
// 自动捞到正文旁边：上一章结尾、这一章该埋/该收的伏笔、缺了什么也说出来。
//
// 两个跟 siweina/dsh-novel-writer 学的点：
// ① 伏笔带上「埋了多久」—— 没有这个数，看不出「该收了」；
// ② 取不到的材料要**明说**（他们的 degraded 数组），别静默给个空。

function chapterContext(root, dir, rel) {
  const bookDir = path.join(root, dir)
  const chapters = listChapters(bookDir)
  const index = chapters.findIndex((c) => c.path === rel)
  const current = index >= 0 ? chapters[index] : null
  const n = current ? current.n : 0
  const degraded = []

  let prev = null
  if (index > 0) {
    const before = chapters[index - 1]
    try {
      const raw = fs.readFileSync(path.join(bookDir, '正文', before.file), 'utf8')
      const body = raw.replace(/^#\s*[^\n]*\n?/, '').trim()
      prev = { title: before.title, n: before.n, chars: before.chars, tail: body.slice(-520), scope: '只取结尾 520 字' }
    } catch {
      degraded.push('上一章读不到')
    }
  } else if (index === 0) {
    degraded.push('这是第一章，没有前情')
  }

  const issues = []
  const table = path.join(bookDir, '05_伏笔表.md')
  const isChapter = String(rel).startsWith('正文/')
  if (!isChapter) {
    // 设定文件本来就没有章号，别按章节报「定位不到章号」——那是误报。
    return { n: 0, prev: null, issues: [], degraded: [], isSetting: true }
  }
  if (!n) {
    degraded.push('定位不到章号（文件名里没有「第N章」）')
  } else if (!fs.existsSync(table)) {
    degraded.push('没有 05_伏笔表.md —— 这一章该埋什么、该收什么，取不到')
  } else {
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
        const buriedAt = chapterOf(cells[3])
        const collectAt = chapterOf(cells[4])
        if (buriedAt === n) {
          issues.push({ no: Number(no), name, kind: '埋', where: cells[3], span: null })
        }
        if (collectAt === n) {
          issues.push({
            no: Number(no),
            name,
            kind: '收',
            where: cells[4],
            buriedAt: buriedAt || null,
            span: buriedAt ? Math.max(0, n - buriedAt) : null,
          })
        }
      }
    } catch {
      degraded.push('05_伏笔表.md 解析失败（表格格式变了？）')
    }
  }

  return { n, prev, issues, degraded }
}



// ─── 开工前取材料 ───────────────────────────────────────────
// 两条触发线，先到先算：
// ① **每章** —— 每次写新章都来取材料（前情 + 本章伏笔），很轻；
// ② **每几次对话** —— 每 3 次开工（= 3 段写书对话）强制重读一次全书设定，
//    因为设定文件合起来 2.5–3 万 token，读它比写一章还贵，不能每章都读。
// 另外隔了 12 小时或跨了 3 章也补一次，防止长期不开工。

const REREAD_CALLS = 3
const REREAD_CHAPTERS = 3
const REREAD_HOURS = 12

function bookBrief(root, dir, n) {
  const bookDir = path.join(root, dir)
  const chapters = listChapters(bookDir)
  if (!chapters.length) throw Object.assign(new Error('这本书还没有正文'), { status: 404 })
  const wanted = chapters.find((c) => c.n === Number(n)) || chapters[chapters.length - 1]
  const ctx = chapterContext(root, dir, wanted.path)
  const state = readState(root)
  const now = Date.now()
  const briefs = (typeof state.briefCount === 'number' ? state.briefCount : 0) + 1
  const hours = typeof state.lastBriefAt === 'number' ? Math.max(0, Math.round((now - state.lastBriefAt) / 3600e3)) : null
  const chaptersSince =
    typeof state.lastBriefChapter === 'number' ? Math.max(0, wanted.n - state.lastBriefChapter) : null
  // 第 1、4、7… 次开工读全书设定；其余只取轻材料。
  const byCalls = briefs % REREAD_CALLS === 1
  const adviseFullRead =
    byCalls || hours === null || hours >= REREAD_HOURS || (chaptersSince !== null && chaptersSince >= REREAD_CHAPTERS)
  writeState(root, { lastBriefAt: now, lastBriefChapter: wanted.n, briefCount: briefs })
  return {
    book: dir,
    chapter: { n: wanted.n, title: wanted.title, chars: wanted.chars },
    prev: ctx.prev,
    issues: ctx.issues,
    degraded: ctx.degraded,
    since: { hours, chaptersSince, briefs },
    adviseFullRead,
    reason: byCalls
      ? `第 ${briefs} 次开工（每 ${REREAD_CALLS} 次读一次全书设定）`
      : hours !== null && hours >= REREAD_HOURS
        ? `隔了 ${hours} 小时没开工`
        : chaptersSince !== null && chaptersSince >= REREAD_CHAPTERS
          ? `跨了 ${chaptersSince} 章`
          : '',
    fullReadFiles: adviseFullRead ? ['01_世界观.md', '02_人物.md', '07_时间线.md'] : [],
  }
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

// ─── 全书体检 ───────────────────────────────────────────────
// 学的 akira399/dsh-novel-writer 的 consistency 与 siweina/dsh-novel-writer 的 graph：
// ① 人物缺席矩阵 —— 「人丢了」是可算的，不是凭感觉；
// ② 正文时间标记归一（第三天 / 第3天）—— 后章比前章早就是倒挂。
// 他们靠结构化账本，我们只有 md，所以从正文里抽，抽不到的记进 degraded。

/** 中文数字 → 阿拉伯（支持 零一二两三四五六七八九十、十X、X十、X十Y）。抄自 akira399 的 cons-detect.ts。 */
const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function chineseToNumber(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  if (!/^[零一二两三四五六七八九十]{1,3}$/.test(raw)) return null
  if (raw.includes('十')) {
    const [tensText = '', onesText = ''] = raw.split('十')
    const tens = tensText === '' ? 1 : CN_DIGITS[tensText] ?? 0
    const ones = onesText === '' ? 0 : CN_DIGITS[onesText] ?? 0
    return tens * 10 + ones
  }
  return CN_DIGITS[raw] ?? null
}

// 02_人物.md 里 `## ` 开头的既有人物也有章节（次要角色 / 取名风格 / 角色关系…），
// 这些不是人名。实测混进名单会让「人物出场」那栏多出四条假的。
const NOT_A_PERSON = new Set([
  '人物',
  '主要角色',
  '次要角色',
  '角色关系',
  '人物关系',
  '取名风格',
  '命名风格',
  '设定',
  '规则',
  '附录',
  '目录',
  '索引',
  '档案',
  '备注',
  '其他',
])

function parseCharacterNames(bookDir) {
  const file = path.join(bookDir, '02_人物.md')
  if (!fs.existsSync(file)) return { names: [], degraded: ['没有 02_人物.md —— 人物连续性查不了'] }
  const names = []
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const hit = line.match(/^##\s+(.+)$/)
      if (!hit) continue
      const name = hit[1]
        .replace(/[（(].*$/, '')
        .replace(/^\d+[.、]\s*/, '')
        .trim()
      if (!name || NOT_A_PERSON.has(name) || /^(人物|目录|索引|附录|关系|档案|设定|规则)/.test(name)) continue
      names.push(name)
    }
  } catch {
    return { names: [], degraded: ['02_人物.md 读不动'] }
  }
  return { names: [...new Set(names)], degraded: [] }
}

function bookInsight(root, dir) {
  const bookDir = path.join(root, dir)
  const chapters = listChapters(bookDir)
  const parsed = parseCharacterNames(bookDir)
  const degraded = [...parsed.degraded]

  // 每人每章在不在
  const texts = chapters.map((c) => {
    try {
      return fs.readFileSync(path.join(bookDir, '正文', c.file), 'utf8')
    } catch {
      return ''
    }
  })
  const rows = chapters.map((c, i) => ({
    n: c.n,
    title: c.title,
    present: parsed.names.filter((name) => texts[i].includes(name)),
  }))

  // 连续缺席 ≥3 章（siweina 的默认阈值是 5，我们的书还短，先降一档）
  const THRESHOLD = 3
  const absences = []
  for (const name of parsed.names) {
    let startIndex = null
    for (let i = 0; i <= rows.length; i += 1) {
      const here = i < rows.length && rows[i].present.includes(name)
      if (!here && startIndex === null) startIndex = i
      if (here && startIndex !== null) {
        const length = i - startIndex
        if (length >= THRESHOLD) {
          absences.push({ name, from: rows[startIndex].n, to: rows[i - 1].n, length })
        }
        startIndex = null
      }
    }
  }

  // 正文里的「第 N 天」
  // 正文里的「第 N 天」。一章可能提好几个（回忆里的"第一天"），
  // 取**最后一个**当章末时间 —— 取第一个会撞上开头的回溯。
  const timeline = []
  const noTime = []
  for (let i = 0; i < chapters.length; i += 1) {
    const all = [...texts[i].matchAll(/第\s*([0-9零一二两三四五六七八九十]{1,3})\s*天/g)]
    if (all.length === 0) {
      noTime.push(chapters[i].n)
      continue
    }
    const day = chineseToNumber(all[all.length - 1][1])
    if (day === null) {
      noTime.push(chapters[i].n)
      continue
    }
    timeline.push({ n: chapters[i].n, day })
  }
  const timeIssues = []
  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i].day < timeline[i - 1].day) {
      timeIssues.push({
        n: timeline[i].n,
        day: timeline[i].day,
        prevN: timeline[i - 1].n,
        prevDay: timeline[i - 1].day,
      })
    }
  }
  if (timeline.length === 0) degraded.push('正文里没找到「第 N 天」—— 时间线查不了')
  else if (noTime.length > 0) degraded.push(`第 ${noTime.join('、')} 章正文里没有「第 N 天」`)

  return {
    characters: parsed.names,
    rows,
    absences,
    timeline,
    timeIssues,
    degraded,
    // 一页能看完的摘要
    summary: {
      chapters: chapters.length,
      characters: parsed.names.length,
      absentWarnings: absences.length,
      timeWarnings: timeIssues.length,
    },
  }
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
        if (route === '/insight') {
          if (!isPlainName(dir)) throw Object.assign(new Error('缺少书名'), { status: 400 })
          return json(res, 200, bookInsight(root, dir))
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
        '**要动笔写新的一章之前，先调 action=brief（可带 n=章号）**：它返回上一章结尾、这一章该埋/该收的伏笔，' +
        '并告诉你距上次开工过了多少小时、期间写了几章 —— 到点会提示该重读 01 世界观 / 02 人物 / 07 时间线。' +
        'action=list 列出全部书；action=set 切换当前书（book 传 books/ 下的文件夹名）。' +
        '数据来自 books/ 目录，和写书面板是同一份。',
      parameters: {
        action: { type: 'string', description: 'current（默认）/ list / set / brief' },
        n: { type: 'number', description: 'action=brief 时的章号；省略就用最后一章（按章号找，找不到取最新）' },
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

        if (action === 'brief') {
          const bookDirName = String((args && args.book) || state.current || (books[0] && books[0].dir) || '')
          const book = books.find((b) => b.dir === bookDirName || b.title === bookDirName)
          if (!book) return { ok: false, message: `没有这本书：${bookDirName || '（空）'}` }
          const info = bookBrief(root, book.dir, args && args.n)
          return {
            ok: true,
            ...info,
            message: [
              `《${book.title}》· ${info.chapter.title || `第 ${info.chapter.n} 章`}（${info.chapter.chars} 字）`,
              info.since.hours === null
                ? `第 ${info.since.briefs} 次开工取材料`
                : `第 ${info.since.briefs} 次开工 · 距上次 ${info.since.hours} 小时 · 期间写了 ${info.since.chaptersSince ?? 0} 章`,
              info.prev ? `前情：${info.prev.title}，结尾 ${info.prev.tail.slice(-80)}` : '没有前一章',
              info.issues.length
                ? '伏笔：' + info.issues.map((i) => `${i.kind} ${i.name}`).join('；')
                : '伏笔：本章没有要埋或要收的',
              info.adviseFullRead
                ? `⚠️ 该重读设定（${info.reason || '到点了'}）：${info.fullReadFiles.join('、')}`
                : '不用重读全书设定，这次只取轻材料',
              info.degraded.length ? `缺口：${info.degraded.join('；')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
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
