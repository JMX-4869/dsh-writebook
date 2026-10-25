/**
 * 写书（writebook）—— Client 半边。
 *
 * 侧边栏一个「写书」图标，点开是书架：书架 → 书（目录 / 设定）→ 章节（读 / 改）。
 * 数据走 Host 的 /writebook-api，不碰 DOM、不嵌 iframe。
 */
window.__ModuleLoader__.load({
  id: '@local/writebook',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/writebook-api'
    const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", Georgia, serif'

    async function api(path, options) {
      const opts = options || {}
      const headers = { accept: 'application/json' }
      if (opts.body) headers['content-type'] = 'application/json'
      const res = await fetch(API + path, { ...opts, headers })
      let data = {}
      try {
        data = await res.json()
      } catch {
        /* 空响应 */
      }
      if (!res.ok) {
        const error = new Error(data && data.error ? data.error : `HTTP ${res.status}`)
        error.status = res.status
        error.data = data
        throw error
      }
      return data
    }

    const fmt = (n) => (n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n))
    const ago = (ms) => {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 60e3) return '刚刚'
      if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`
      if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`
      return `${Math.floor(diff / 86400e3)} 天前`
    }

    const CSS = `
.wb-root{height:100%;min-height:520px;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden;border-radius:2px}
.wb-bar{display:flex;align-items:center;gap:10px;padding:18px 28px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.wb-bar h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.01em}
.wb-bar .sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wb-bar .spacer{flex:1}
.wb-scroll{flex:1;overflow:auto;padding:22px 28px 80px}
.wb-card.current{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.wb-cur{align-self:flex-start;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:#fff}
.wb-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;max-width:1180px}
.wb-card{text-align:left;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px;cursor:pointer;display:flex;flex-direction:column;gap:9px;transition:border-color .15s ease,transform .15s ease}
.wb-card:hover{border-color:var(--dsw-alias-brand-primary);transform:translateY(-1px)}
.wb-card .t{font-size:15px;font-weight:600}
.wb-card .line{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65;min-height:34px}
.wb-tags{display:flex;gap:6px;flex-wrap:wrap}
.wb-tag{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.wb-tag.on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.wb-nums{display:flex;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:auto;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1)}
.wb-nums b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.wb-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:12.5px;cursor:pointer;font-family:inherit;transition:border-color .12s ease,background .12s ease}
.wb-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.wb-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.wb-btn.primary:hover{filter:brightness(1.08)}
.wb-btn:disabled{opacity:.5;cursor:default}
.wb-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.wb-btn.ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.wb-input{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary);outline:none;font-family:inherit;min-width:0}
.wb-input:focus{border-color:var(--dsw-alias-brand-primary)}
.wb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 28px;flex:none}
.wb-tab{padding:9px 14px;font-size:13px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-bottom:2px solid transparent;margin-bottom:-1px;font-family:inherit}
.wb-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.wb-toc{max-width:920px;display:flex;flex-direction:column;gap:1px}
.wb-row{display:flex;align-items:center;gap:12px;padding:9px 12px;border-radius:8px;cursor:pointer;border:1px solid transparent;background:transparent;text-align:left;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);width:100%}
.wb-row:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1)}
.wb-row .idx{width:36px;flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;text-align:right}
.wb-row .name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-row .num{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.wb-read{max-width:740px;margin:0 auto}
.wb-read h2{font-size:22px;margin:0 0 8px;font-weight:600;line-height:1.4}
.wb-read .meta{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:20px;display:flex;gap:14px;align-items:center}
.wb-prose{font-family:${SERIF};font-size:16.5px;line-height:1.95;white-space:pre-wrap;word-break:break-word;letter-spacing:.01em}
.wb-editor{width:100%;box-sizing:border-box;min-height:62vh;font-family:${SERIF};font-size:16px;line-height:1.9;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px 18px;resize:vertical;outline:none;white-space:pre-wrap}
.wb-editor:focus{border-color:var(--dsw-alias-brand-primary)}
.wb-err{margin:0 0 14px;padding:8px 12px;border-radius:8px;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);display:flex;gap:10px;align-items:center}
.wb-empty{padding:60px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:2}
.wb-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 0 4px}
.wb-bookhead{max-width:920px;margin:0 0 18px}
.wb-bookhead .t{font-size:20px;font-weight:600;margin:0 0 6px}
.wb-bookhead .one{font-size:13px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.wb-list{margin-top:10px;display:flex;flex-direction:column}
.wb-loading{padding:40px;color:var(--dsw-alias-label-secondary);font-size:13px}
.wb-note{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:11px 14px;background:var(--dsw-alias-bg-layer-1);margin-bottom:8px;cursor:pointer;text-align:left;width:100%;font-family:inherit;color:var(--dsw-alias-label-primary);display:block}
.wb-note:hover{border-color:var(--dsw-alias-brand-primary)}
.wb-note.related{border-left:3px solid var(--dsw-alias-brand-primary)}
.wb-note .sym{font-size:13px;font-weight:600;line-height:1.5}
.wb-note .meta2{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px;display:flex;gap:10px}
.wb-note-body{white-space:pre-wrap;font-size:13px;line-height:1.75;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px;margin:-2px 0 12px}
.wb-textarea{box-sizing:border-box;width:100%;min-height:88px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);font-family:inherit;resize:vertical;outline:none}
.wb-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.wb-field{display:flex;flex-direction:column;gap:5px;margin-bottom:9px}
.wb-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.wb-formbox{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px;margin-bottom:14px;max-width:640px}
.wb-note-bar{display:flex;gap:8px;align-items:center;padding:0 28px;height:0;overflow:hidden;border-bottom:1px solid transparent;transition:height .12s ease,padding .12s ease}
.wb-note-bar.open{height:46px;padding:8px 28px;border-bottom-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.wb-ctx{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 14px;margin-bottom:18px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.wb-ctx-row{display:flex;gap:10px;font-size:12px;line-height:1.75}
.wb-ctx .k{flex:none;color:var(--dsw-alias-label-secondary);min-width:50px}
.wb-ctx .v{color:var(--dsw-alias-label-primary);overflow:hidden}
`

    const btn = (label, onClick, extra) =>
      h(
        'button',
        {
          type: 'button',
          className: 'wb-btn' + (extra && extra.primary ? ' primary' : '') + (extra && extra.ghost ? ' ghost' : ''),
          onClick,
          disabled: !!(extra && extra.disabled),
          title: extra && extra.title,
          key: extra && extra.key,
        },
        label,
      )

    function BookIcon(props) {
      const size = (props && props.size) || 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M4.5 5.2A2.2 2.2 0 0 1 6.7 3H19v15.3H6.7a2.2 2.2 0 0 0-2.2 2.2V5.2Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 7.2h7.2M8 10.6h4.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { d: 'M4.5 20.5h14.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function ErrBar({ message, onClose }) {
      if (!message) return null
      return h(
        'div',
        { className: 'wb-err' },
        h('span', { style: { flex: 1 } }, message),
        h('button', { type: 'button', className: 'wb-btn ghost', onClick: onClose }, '知道了'),
      )
    }

    // ─── 书架 ───────────────────────────────────────────────
    function Shelf({ onOpen, onNotes }) {
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const [formOpen, setFormOpen] = useState(false)
      const [form, setForm] = useState({ title: '', type: '', oneLine: '' })
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setData(await api('/books'))
        } catch (error) {
          setErr(error.message)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const setCurrent = async (dir) => {
        try {
          await api('/current', { method: 'POST', body: JSON.stringify({ dir }) })
          await load()
        } catch (error) {
          setErr(error.message)
        }
      }

      const create = async () => {        if (!form.title.trim() || busy) return
        setBusy(true)
        try {
          await api('/book/new', { method: 'POST', body: JSON.stringify(form) })
          setForm({ title: '', type: '', oneLine: '' })
          setFormOpen(false)
          await load()
        } catch (error) {
          setErr(error.message)
        } finally {
          setBusy(false)
        }
      }

      const books = (data && data.books) || []
      const total = books.reduce((sum, b) => sum + b.chars, 0)

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-bar' },
          h('h1', null, '写书'),
          h('span', { className: 'sub' }, data ? `${books.length} 本 · ${fmt(total)} 字 · ${data.root}` : '加载中…'),
          h('span', { className: 'spacer' }),
          btn('写作经验', onNotes),
          btn(formOpen ? '收起' : '新建书', () => setFormOpen((v) => !v)),
          btn('刷新', load, { ghost: true }),
        ),
        h(
          'div',
          { className: 'wb-scroll' },
          h(ErrBar, { message: err, onClose: () => setErr('') }),
          formOpen &&
            h(
              'div',
              { className: 'wb-form' },
              h('input', {
                className: 'wb-input',
                placeholder: '书名',
                value: form.title,
                style: { width: 180 },
                onChange: (e) => setForm({ ...form, title: e.target.value }),
              }),
              h('input', {
                className: 'wb-input',
                placeholder: '类型（可空）',
                value: form.type,
                style: { width: 140 },
                onChange: (e) => setForm({ ...form, type: e.target.value }),
              }),
              h('input', {
                className: 'wb-input',
                placeholder: '一句话（可空）',
                value: form.oneLine,
                style: { flex: 1, minWidth: 200 },
                onChange: (e) => setForm({ ...form, oneLine: e.target.value }),
              }),
              btn(busy ? '建…' : '建', create, { primary: true, disabled: busy }),
            ),
          data === null && h('div', { className: 'wb-loading' }, '加载中…'),
          data !== null &&
            books.length === 0 &&
            h(
              'div',
              { className: 'wb-empty' },
              'books/ 底下还没有书。',
              h('br'),
              '放一个文件夹 + 书.json 进来，或者点上面的「新建书」。',
            ),
          h(
            'div',
            { className: 'wb-shelf' },
            books.map((book) => {
              const isCurrent = data && data.current === book.dir
              return h(
                'div',
                {
                  key: book.dir,
                  className: 'wb-card' + (isCurrent ? ' current' : ''),
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => onOpen(book.dir),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') onOpen(book.dir)
                  },
                },
                isCurrent ? h('div', { className: 'wb-cur' }, '当前在写') : null,
                h('div', { className: 't' }, book.title),
                h('div', { className: 'wb-tags' },
                  book.type && h('span', { className: 'wb-tag' }, book.type),
                  book.status && h('span', { className: 'wb-tag on' }, book.status),
                  book.volume && h('span', { className: 'wb-tag' }, book.volume),
                ),
                h('div', { className: 'line' }, book.oneLine || '（还没有一句话简介）'),
                h(
                  'div',
                  { className: 'wb-nums' },
                  h('span', null, h('b', null, book.chapters), ' 章'),
                  h('span', null, h('b', null, fmt(book.chars)), ' 字'),
                  h('span', null, ago(book.updated)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wb-btn' + (isCurrent ? ' ghost' : ''),
                    style: { marginTop: 8, alignSelf: 'flex-start' },
                    disabled: isCurrent,
                    onClick: (e) => {
                      e.stopPropagation()
                      setCurrent(book.dir)
                    },
                  },
                  isCurrent ? '就是这本' : '设为当前',
                ),
              )
            }),
          ),
        ),
      )
    }

    // ─── 一本书 ─────────────────────────────────────────────
    function BookView({ dir, onBack, onOpen, onChanged }) {
      const [detail, setDetail] = useState(null)
      const [tab, setTab] = useState('toc')
      const [err, setErr] = useState('')
      const [adding, setAdding] = useState(false)
      const [title, setTitle] = useState('')
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setDetail(await api(`/book?dir=${encodeURIComponent(dir)}`))
        } catch (error) {
          setErr(error.message)
        }
      }, [dir])

      useEffect(() => {
        setDetail(null)
        load()
      }, [load])

      const addChapter = async () => {
        if (!title.trim() || busy) return
        setBusy(true)
        try {
          const res = await api('/chapter/new', {
            method: 'POST',
            body: JSON.stringify({ dir, title: title.trim() }),
          })
          setTitle('')
          setAdding(false)
          await load()
          if (onChanged) onChanged()
          onOpen(dir, res.chapter.path, res.chapter.title)
        } catch (error) {
          setErr(error.message)
        } finally {
          setBusy(false)
        }
      }

      const book = detail && detail.book
      const chapters = (detail && detail.chapters) || []
      const settings = (detail && detail.settings) || []

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-bar' },
          btn('← 书架', onBack, { ghost: true }),
          h('h1', null, book ? book.title : dir),
          book && book.status ? h('span', { className: 'sub' }, book.status) : null,
          h('span', { className: 'spacer' }),
          btn('刷新', load, { ghost: true }),
        ),
        h(
          'div',
          { className: 'wb-tabs' },
          h(
            'button',
            { type: 'button', className: 'wb-tab' + (tab === 'toc' ? ' on' : ''), onClick: () => setTab('toc') },
            `目录 ${chapters.length}`,
          ),
          h(
            'button',
            { type: 'button', className: 'wb-tab' + (tab === 'settings' ? ' on' : ''), onClick: () => setTab('settings') },
            `设定 ${settings.length}`,
          ),
          h(
            'button',
            { type: 'button', className: 'wb-tab' + (tab === 'insight' ? ' on' : ''), onClick: () => setTab('insight') },
            '体检',
          ),
        ),
        h(
          'div',
          { className: 'wb-scroll' },
          h(ErrBar, { message: err, onClose: () => setErr('') }),
          h('div', { className: 'wb-loading' }, detail === null ? '加载中…' : null),
          detail !== null &&
            h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'wb-bookhead' },
                book.oneLine ? h('p', { className: 'one' }, book.oneLine) : null,
                !book.oneLine && book.note ? h('p', { className: 'one' }, book.note) : null,
              ),
              tab === 'toc' &&
                h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'wb-form' },
                    adding
                      ? h(
                          React.Fragment,
                          null,
                          h('input', {
                            className: 'wb-input',
                            placeholder: '这一章叫什么（第 N 章自动排）',
                            value: title,
                            style: { width: 260 },
                            autoFocus: true,
                            onChange: (e) => setTitle(e.target.value),
                            onKeyDown: (e) => {
                              if (e.key === 'Enter') addChapter()
                              if (e.key === 'Escape') setAdding(false)
                            },
                          }),
                          btn(busy ? '建…' : '建', addChapter, { primary: true, disabled: busy }),
                          btn('取消', () => setAdding(false), { ghost: true }),
                        )
                      : btn('+ 新建章', () => setAdding(true)),
                  ),
                  h(
                    'div',
                    { className: 'wb-toc' },
                    chapters.map((chapter) =>
                      h(
                        'div',
                        {
                          key: chapter.file,
                          className: 'wb-row',
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => onOpen(dir, chapter.path, chapter.title),
                          onKeyDown: (e) => {
                            if (e.key === 'Enter') onOpen(dir, chapter.path, chapter.title)
                          },
                        },
                        h('span', { className: 'idx' }, chapter.n ? String(chapter.n) : '—'),
                        h('span', { className: 'name' }, chapter.title),
                        h('span', { className: 'num' }, `${chapter.chars} 字`),
                      ),
                    ),
                  ),
                  chapters.length === 0 && h('div', { className: 'wb-empty' }, '还没有正文。'),
                ),
              tab === 'settings' &&
                h(
                  'div',
                  { className: 'wb-toc' },
                  settings.map((setting) =>
                    h(
                      'div',
                      {
                        key: setting.file,
                        className: 'wb-row',
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => onOpen(dir, setting.path, setting.title),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') onOpen(dir, setting.path, setting.title)
                        },
                      },
                      h('span', { className: 'idx' }, setting.file.slice(0, 2)),
                      h('span', { className: 'name' }, setting.title),
                      h('span', { className: 'num' }, `${setting.chars} 字`),
                    ),
                  ),
                  settings.length === 0 && h('div', { className: 'wb-empty' }, '这本书还没有设定文件。'),
                ),
              tab === 'insight' && h(InsightPane, { dir, onErr: setErr }),
            ),
        ),
      )
    }

    // ─── 全书体检（人物没丢 / 时间没倒） ─────────────────────
    function InsightPane({ dir, onErr }) {
      const [data, setData] = useState(null)

      const load = useCallback(async () => {
        try {
          setData(await api(`/insight?dir=${encodeURIComponent(dir)}`))
        } catch (error) {
          onErr(error.message)
        }
      }, [dir, onErr])

      useEffect(() => {
        load()
      }, [load])

      const rows = (data && data.rows) || []
      const absences = (data && data.absences) || []
      const timeIssues = (data && data.timeIssues) || []
      const counts = new Map()
      for (const row of rows) {
        for (const name of row.present) counts.set(name, (counts.get(name) || 0) + 1)
      }

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-form' },
          btn('刷新', load, { ghost: true }),
          data
            ? h(
                'span',
                { className: 'sub', style: { fontSize: 11 } },
                `${data.summary.chapters} 章 · ${data.summary.characters} 人 · 缺席告警 ${data.summary.absentWarnings} · 时间告警 ${data.summary.timeWarnings}`,
              )
            : null,
        ),
        data === null && h('div', { className: 'wb-loading' }, '加载中…'),
        data &&
          data.degraded.length > 0 &&
          h(
            'div',
            { className: 'wb-ctx-row', style: { marginBottom: 12 } },
            h('span', { className: 'k' }, '缺口'),
            h(
              'span',
              { className: 'v', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
              data.degraded.join('；'),
            ),
          ),
        data &&
          h(
            'div',
            { style: { marginBottom: 18 } },
            h('div', { className: 'sub', style: { fontSize: 11, marginBottom: 8 } }, '人物出场'),
            data.characters.map((name) => {
              const gone = absences.filter((a) => a.name === name)
              return h(
                'div',
                { className: 'wb-ctx-row', key: name },
                h('span', { className: 'k', style: { minWidth: 72 } }, name),
                h(
                  'span',
                  { className: 'v' },
                  `${counts.get(name) || 0} / ${rows.length} 章` +
                    (gone.length
                      ? ' · 连续缺席 ' +
                        gone.map((a) => `第 ${a.from}–${a.to} 章（${a.length} 章）`).join('、')
                      : ''),
                ),
              )
            }),
            data.characters.length === 0 && h('div', { className: 'wb-empty' }, '没解析出人物名。'),
          ),
        data &&
          h(
            'div',
            null,
            h('div', { className: 'sub', style: { fontSize: 11, marginBottom: 8 } }, '书内时间'),
            data.timeline.length > 0
              ? h(
                  'div',
                  { className: 'wb-ctx-row' },
                  h('span', { className: 'k' }, '天'),
                  h(
                    'span',
                    { className: 'v' },
                    data.timeline.map((t) => `第${t.n}章=${t.day}天`).join(' → '),
                  ),
                )
              : h('div', { className: 'wb-empty' }, '正文里没有「第 N 天」。'),
            timeIssues.length > 0 &&
              h(
                'div',
                { className: 'wb-ctx-row' },
                h('span', { className: 'k' }, '倒挂'),
                h(
                  'span',
                  { className: 'v', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                  timeIssues
                    .map((i) => `第 ${i.n} 章是第 ${i.day} 天，比第 ${i.prevN} 章（第 ${i.prevDay} 天）早`)
                    .join('；'),
                ),
              ),
          ),
      )
    }

    // ─── 写作经验（跨书通用，存在工作区的 procedures/） ─────────
    const SCENE_ORDER = ['开局', '结构', '对话', '节奏', '描写', '人物', '伏笔', '收尾', '语言', '未分类']

    function NotesPane({ onErr }) {
      const [data, setData] = useState(null)
      const [open, setOpen] = useState(null)
      const [adding, setAdding] = useState(false)
      const [form, setForm] = useState({ symptom: '', scene: '', fix: '', unless: '' })
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          setData(await api('/notes'))
        } catch (error) {
          onErr(error.message)
        }
      }, [onErr])

      useEffect(() => {
        load()
      }, [load])

      const openCard = async (id) => {
        try {
          setOpen(await api(`/note?id=${encodeURIComponent(id)}`))
        } catch (error) {
          onErr(error.message)
        }
      }

      const save = async () => {
        if (!form.symptom.trim() || busy) return
        setBusy(true)
        try {
          await api('/note', {
            method: 'POST',
            body: JSON.stringify({ ...form, title: form.symptom.trim().slice(0, 20) }),
          })
          setForm({ symptom: '', scene: '', fix: '', unless: '' })
          setAdding(false)
          await load()
        } catch (error) {
          onErr(error.message)
        } finally {
          setBusy(false)
        }
      }

      const cards = (data && data.cards) || []
      const groups = new Map()
      for (const card of cards) {
        const key = card.scene || '未分类'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(card)
      }
      const order = [...groups.keys()].sort((a, b) => {
        const ia = SCENE_ORDER.indexOf(a)
        const ib = SCENE_ORDER.indexOf(b)
        return (ia < 0 ? 98 : ia) - (ib < 0 ? 98 : ib) || a.localeCompare(b)
      })

      const row = (card) =>
        h(
          React.Fragment,
          { key: card.id },
          h(
            'button',
            {
              type: 'button',
              className: 'wb-note related',
              onClick: () => (open && open.id === card.id ? setOpen(null) : openCard(card.id)),
            },
            h('div', { className: 'sym' }, card.trigger),
            h(
              'div',
              { className: 'meta2' },
              h('span', null, ago(card.mtime)),
              h('span', null, `${Math.max(1, Math.round(card.bytes / 1024))} KB`),
            ),
          ),
          open && open.id === card.id && h('div', { className: 'wb-note-body' }, open.raw),
        )

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-form' },
          btn(adding ? '收起' : '+ 记一条', () => setAdding((v) => !v)),
          btn('刷新', load, { ghost: true }),
          h('span', { className: 'sub', style: { fontSize: 11 } }, '写小说的通用经验，不分书 —— 新开一本也能用'),
        ),
        adding &&
          h(
            'div',
            { className: 'wb-formbox' },
            h(
              'div',
              { className: 'wb-field' },
              h('label', null, '症状 —— 下次会拿它去搜的词'),
              h('input', {
                className: 'wb-input',
                value: form.symptom,
                placeholder: '例：一章写完像流水账 / 对话里把推理全说完',
                onChange: (e) => setForm({ ...form, symptom: e.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'wb-field' },
              h('label', null, '场景（用来分组：开局 / 结构 / 对话 / 节奏 / 描写 / 人物 / 伏笔 / 收尾 / 语言）'),
              h('input', {
                className: 'wb-input',
                value: form.scene,
                placeholder: '留空就进「未分类」',
                onChange: (e) => setForm({ ...form, scene: e.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'wb-field' },
              h('label', null, '解法'),
              h('textarea', {
                className: 'wb-textarea',
                value: form.fix,
                onChange: (e) => setForm({ ...form, fix: e.target.value }),
              }),
            ),
            h(
              'div',
              { className: 'wb-field' },
              h('label', null, '什么时候不适用（可空）'),
              h('textarea', {
                className: 'wb-textarea',
                style: { minHeight: 52 },
                value: form.unless,
                onChange: (e) => setForm({ ...form, unless: e.target.value }),
              }),
            ),
            btn(busy ? '存…' : '存成一张卡', save, { primary: true, disabled: busy }),
          ),
        data === null && h('div', { className: 'wb-loading' }, '加载中…'),
        data && data.inbox > 0
          ? h(
              'div',
              { className: 'wb-tag on', style: { marginBottom: 12, display: 'inline-block', fontSize: 11.5 } },
              `inbox ${data.inbox} 行待整理 —— 边写边记的都堆在那儿`,
            )
          : null,
        data !== null &&
          cards.length === 0 &&
          h('div', { className: 'wb-empty' }, '还没有经验卡。写完一章发现毛病，就在上面记一条 —— 它跟着你所有书走。'),
        data !== null &&
          order.map((scene) =>
            h(
              'div',
              { key: scene, style: { marginBottom: 16 } },
              h('div', { className: 'sub', style: { fontSize: 11, marginBottom: 8 } }, `${scene} · ${groups.get(scene).length}`),
              groups.get(scene).map(row),
            ),
          ),
      )
    }

    // ─── 写作经验整页（不挂在任何一本书上） ──────────────────
    function NotesView({ onBack }) {
      const [err, setErr] = useState('')
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-bar' },
          btn('← 书架', onBack, { ghost: true }),
          h('h1', null, '写作经验'),
          h('span', { className: 'sub' }, '跨书通用 —— 不挂在任何一本书上'),
          h('span', { className: 'spacer' }),
        ),
        h(
          'div',
          { className: 'wb-scroll' },
          h(ErrBar, { message: err, onClose: () => setErr('') }),
          h(NotesPane, { onErr: setErr }),
        ),
      )
    }

    // ─── 读 / 改 ────────────────────────────────────────────
    function Reader({ dir, path: rel, onBack, onChanged }) {
      const [file, setFile] = useState(null)
      const [draft, setDraft] = useState('')
      const [editing, setEditing] = useState(false)
      const [err, setErr] = useState('')
      const [busy, setBusy] = useState(false)
      const [noteOpen, setNoteOpen] = useState(false)
      const [noteText, setNoteText] = useState('')
      const [msg, setMsg] = useState('')
      const [savedAt, setSavedAt] = useState('')
      const [ctx, setCtx] = useState(null)

      // 边写边记：一行就够，带上书名和章名，落在 procedures/_inbox.md。
      // 不用离开当前这一章，也不用管它归哪个环节 —— 那是整理时的事。
      const saveNote = async () => {
        const text = noteText.trim()
        if (!text) return
        try {
          const where = file ? file.title : rel
          await api('/inbox', {
            method: 'POST',
            body: JSON.stringify({ line: `${dir} · ${where}：${text}` }),
          })
          setNoteText('')
          setMsg('记下了')
          window.setTimeout(() => setMsg(''), 2400)
        } catch (error) {
          setErr(error.message)
        }
      }

      const load = useCallback(async () => {
        try {
          const data = await api(`/file?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(rel)}`)
          setFile(data)
          setDraft(data.raw)
          setEditing(false)
        } catch (error) {
          setErr(error.message)
        }
      }, [dir, rel])

      useEffect(() => {
        setFile(null)
        load()
      }, [load])

      // 这一章之前该看什么：上一章结尾 + 这章该埋/该收的伏笔。
      useEffect(() => {
        let alive = true
        setCtx(null)
        if (!rel.startsWith('正文/')) return () => {}
        api(`/context?dir=${encodeURIComponent(dir)}&path=${encodeURIComponent(rel)}`)
          .then((data) => {
            if (alive) setCtx(data)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [dir, rel])

      // 默认一直保存：编辑态空闲 1.2 秒就落盘，手动「保存」只是立刻做同一件事。
      const save = async (auto) => {
        if (!file || busy) return
        if (file.raw === draft) {
          if (!auto) setEditing(false)
          return
        }
        if (!auto) setBusy(true)
        try {
          const res = await api('/file', {
            method: 'POST',
            body: JSON.stringify({ dir, path: rel, raw: draft, mtime: file.mtime }),
          })
          setFile(res.file)
          setDraft(res.file.raw)
          setErr('')
          setSavedAt(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
          if (!auto) setEditing(false)
          if (onChanged) onChanged()
        } catch (error) {
          setErr(error.message)
        } finally {
          if (!auto) setBusy(false)
        }
      }

      useEffect(() => {
        if (!editing || !file || draft === file.raw) return undefined
        const timer = window.setTimeout(() => {
          save(true)
        }, 1200)
        return () => window.clearTimeout(timer)
      }, [draft, editing, file])

      const body = file ? file.raw.replace(/^#\s*[^\n]*\n?/, '') : ''
      const isSetting = !rel.startsWith('正文/')

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'wb-bar' },
          btn('← 返回', onBack, { ghost: true }),
          h('h1', { style: { fontSize: 15 } }, file ? file.title : rel),
          h('span', { className: 'spacer' }),
          h('span', { className: 'sub' }, msg || (savedAt ? '已保存 ' + savedAt : '')),
          editing
            ? h(
                React.Fragment,
                null,
                btn('记一笔', () => setNoteOpen((v) => !v), { ghost: true, disabled: noteOpen }),
                btn('取消', () => {
                  setEditing(false)
                  setDraft(file.raw)
                }, { ghost: true }),
                btn(busy ? '保存中…' : '保存', () => save(false), { primary: true, disabled: busy }),
              )
            : h(
                React.Fragment,
                null,
                btn('记一笔', () => setNoteOpen((v) => !v), { ghost: true, disabled: noteOpen }),
                btn('重新载入', load, { ghost: true }),
                btn('编辑', () => setEditing(true)),
              ),
        ),
        h(
          'div',
          { className: 'wb-note-bar' + (noteOpen ? ' open' : '') },
          h('input', {
            className: 'wb-input',
            style: { flex: 1 },
            value: noteText,
            placeholder: noteOpen ? '这章踩到什么坑？一句话，回车就记 —— 会带上书名和章名' : '',
            disabled: !noteOpen,
            onChange: (e) => setNoteText(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') saveNote()
              if (e.key === 'Escape') setNoteOpen(false)
            },
          }),
          btn('记下', saveNote, { primary: true, disabled: !noteOpen || !noteText.trim() }),
        ),
        h(
          'div',
          { className: 'wb-scroll' },
          h(ErrBar, { message: err, onClose: () => setErr('') }),
          file === null && h('div', { className: 'wb-loading' }, '加载中…'),
          file !== null &&
            h(
              'div',
              { className: 'wb-read' },
              h('h2', null, file.title),
              h(
                'div',
                { className: 'meta' },
                h('span', null, isSetting ? '设定' : '正文'),
                h('span', null, `${file.chars} 字`),
                h('span', null, ago(file.mtime)),
              ),
              editing
                ? h('textarea', {
                    className: 'wb-editor',
                    value: draft,
                    spellCheck: false,
                    onChange: (e) => setDraft(e.target.value),
                  })
                : h(
                    React.Fragment,
                    null,
                    ctx &&
                      (ctx.prev ||
                        (ctx.issues && ctx.issues.length > 0) ||
                        (ctx.degraded && ctx.degraded.length > 0)) &&
                      h(
                        'div',
                        { className: 'wb-ctx' },
                        ctx.prev &&
                          h(
                            'div',
                            { className: 'wb-ctx-row' },
                            h('span', { className: 'k' }, '前情'),
                            h(
                              'span',
                              { className: 'v', title: ctx.prev.tail },
                              `${ctx.prev.title}（${ctx.prev.chars} 字）${ctx.prev.scope} —— ${ctx.prev.tail.slice(-150)}`,
                            ),
                          ),
                        ctx.issues && ctx.issues.length > 0
                          ? h(
                              'div',
                              { className: 'wb-ctx-row' },
                              h('span', { className: 'k' }, '这一章'),
                              h(
                                'span',
                                { className: 'v' },
                                ctx.issues
                                  .map((i) =>
                                    i.kind === '收' && i.span !== null
                                      ? `收 ${i.name}（埋在第 ${i.buriedAt} 章，隔了 ${i.span} 章）`
                                      : `${i.kind} ${i.name}`,
                                  )
                                  .join('；'),
                              ),
                            )
                          : h(
                              'div',
                              { className: 'wb-ctx-row' },
                              h('span', { className: 'k' }, '这一章'),
                              h('span', { className: 'v' }, '伏笔表里没有要埋或要收的'),
                            ),
                        ctx.degraded && ctx.degraded.length > 0
                          ? h(
                              'div',
                              { className: 'wb-ctx-row' },
                              h('span', { className: 'k' }, '缺口'),
                              h(
                                'span',
                                { className: 'v', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                                ctx.degraded.join('；'),
                              ),
                            )
                          : null,
                      ),
                    h('article', { className: 'wb-prose' }, body.trim() || '（空）'),
                  ),
            ),
        ),
      )
    }

    // ─── 主面板 ─────────────────────────────────────────────
    function WriteBookPanel() {
      const [view, setView] = useState({ kind: 'shelf' })
      const [nonce, setNonce] = useState(0)

      const refresh = () => setNonce((n) => n + 1)

      let content
      if (view.kind === 'book') {
        content = h(BookView, {
          key: `book:${view.dir}:${nonce}`,
          dir: view.dir,
          onBack: () => setView({ kind: 'shelf' }),
          onChanged: refresh,
          onOpen: (dir, path, title) => setView({ kind: 'read', dir, path, title }),
        })
      } else if (view.kind === 'read') {
        content = h(Reader, {
          key: `read:${view.dir}:${view.path}`,
          dir: view.dir,
          path: view.path,
          onChanged: refresh,
          onBack: () => setView({ kind: 'book', dir: view.dir }),
        })
      } else if (view.kind === 'notes') {
        content = h(NotesView, {
          key: `notes:${nonce}`,
          onBack: () => setView({ kind: 'shelf' }),
        })
      } else {
        content = h(Shelf, {
          key: `shelf:${nonce}`,
          onOpen: (dir) => setView({ kind: 'book', dir }),
          onNotes: () => setView({ kind: 'notes' }),
        })
      }

      return h(
        'div',
        { className: 'wb-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        content,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        // 侧边栏：一个「写书」图标，点开主面板（sidebar 的 id 对应 main 的 key）。
        slots.inject('sidebar.panellist', () =>
          slots.register({ name: 'sidebar.panellist', id: 'writebook', order: 20, label: '写书' }, BookIcon),
        )
        slots.inject('main', () => slots.register({ name: 'main', key: 'writebook' }, WriteBookPanel))
        // 设置页：同一块界面再挂一份，从「设置 → 写书」也能进。
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'writebook', order: 32, label: '写书' }, WriteBookPanel),
        )

        // 设置导航里那一格：宿主按 section id 查一张硬编码表画图标，表里没有的 id
        // 一律回退成齿轮，插件没有参与的接口（package.json 的 icon 只影响插件页）。
        // 所以只能等导航渲染出来，把那个 <svg> 的内容换掉。宿主改结构就静默失效。
        const BOOK_PATHS =
          '<path d="M4.5 5.2A2.2 2.2 0 0 1 6.7 3H19v15.3H6.7a2.2 2.2 0 0 0-2.2 2.2V5.2Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
          '<path d="M8 7.2h7.2M8 10.6h4.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'

        const paintNavIcon = () => {
          for (const svg of document.querySelectorAll('svg')) {
            if (svg.getAttribute('data-wb-icon') === '1') continue
            // 图标旁边那格文字是「写书」——往上找三层，命中就换。
            let node = svg.parentElement
            let hit = false
            for (let depth = 0; depth < 3 && node; depth += 1) {
              if ((node.textContent || '').trim() === '写书') {
                hit = true
                break
              }
              node = node.parentElement
            }
            if (!hit) continue
            svg.setAttribute('data-wb-icon', '1')
            svg.setAttribute('viewBox', '0 0 24 24')
            svg.innerHTML = BOOK_PATHS
          }
        }

        ctx.effect(() => {
          let timer = 0
          const tick = () => {
            timer = 0
            try {
              paintNavIcon()
            } catch {
              /* 宿主换结构就当没这回事 */
            }
          }
          const schedule = () => {
            if (!timer) timer = window.setTimeout(tick, 300)
          }
          tick()
          const observer = new MutationObserver(schedule)
          observer.observe(document.body, { childList: true, subtree: true })
          return () => {
            observer.disconnect()
            if (timer) window.clearTimeout(timer)
          }
        })
      },
    }
  },
})
