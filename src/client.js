window.__ModuleLoader__.load({
  id: 'dsh-laputa',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const API = '/dsh-laputa/api'
    const FILES = [
      'MISSION.MD', 'IDENTITY.MD', 'RELATIONSHIP.MD', 'REDLINE.MD', 'DREAM.MD', 'DARK.MD',
    ]
    const CORE = ['IDENTITY.MD', 'MISSION.MD']
    const PANEL_CSS = `
      .laputa-panel{--lp-line:var(--dsw-alias-border-l2,rgba(127,127,127,.24));--lp-line-strong:var(--dsw-alias-border-l3,rgba(127,127,127,.4));--lp-brand:var(--dsw-alias-brand-primary,#2f6fed);--lp-ok:var(--dsw-alias-state-success-primary,#1a7f4b);--lp-warn:var(--dsw-alias-state-warn-primary,#a86a00);--lp-bad:var(--dsw-alias-state-error-primary,#c43b3b);--lp-fg:var(--dsw-alias-label-primary,#1f2329);--lp-fg2:var(--dsw-alias-label-secondary,rgba(0,0,0,.64));--lp-fg3:var(--dsw-alias-label-tertiary,rgba(0,0,0,.46));--lp-bg:var(--dsw-alias-bg-base,#fff);--lp-bg1:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04));--lp-bg2:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));height:100%;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;background:var(--lp-bg);color:var(--lp-fg);font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
      .laputa-panel *{box-sizing:border-box}
      .laputa-panel h1,.laputa-panel h2,.laputa-panel h3,.laputa-panel p{margin:0}
      .lp-head{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:15px 22px 13px;border-bottom:1px solid var(--lp-line);background:linear-gradient(135deg,rgba(96,83,226,.10),rgba(255,122,162,.06) 58%,transparent)}
      .lp-kicker{margin:0 0 2px;font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--lp-fg3)}
      .lp-head h1{font-size:19px;font-weight:660;letter-spacing:.01em}
      .lp-sub{margin-top:3px;font-size:12px;color:var(--lp-fg2);max-width:660px}
      .lp-dots{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px 12px;padding-top:2px;max-width:52%}
      .lp-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--lp-fg2);white-space:nowrap}
      .lp-dot::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--lp-fg3);box-shadow:0 0 0 3px rgba(127,127,127,.12);flex:none}
      .lp-dot.ok::before{background:var(--lp-ok);box-shadow:0 0 0 3px rgba(26,127,75,.16)}
      .lp-dot.warn::before{background:var(--lp-warn);box-shadow:0 0 0 3px rgba(168,106,0,.16)}
      .lp-dot.bad::before{background:var(--lp-bad);box-shadow:0 0 0 3px rgba(196,59,59,.16)}
      .lp-alerts{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 22px 0}
      .lp-alerts:empty{display:none}
      .lp-alert{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 11px;border-radius:9px;border:1px solid var(--lp-line-strong);background:var(--lp-bg2);font-size:12px;color:var(--lp-fg2)}
      .lp-alert.danger{border-color:rgba(196,59,59,.35);background:rgba(196,59,59,.08);color:var(--lp-bad)}
      .lp-alert.warn{border-color:rgba(168,106,0,.35);background:rgba(168,106,0,.08);color:var(--lp-warn)}
      .lp-tabs{flex:none;display:flex;gap:2px;padding:0 14px;margin-top:8px;border-bottom:1px solid var(--lp-line);background:var(--lp-bg1)}
      .lp-tab{flex:none;appearance:none;background:none;border:0;border-bottom:2px solid transparent;border-radius:6px 6px 0 0;margin:0;padding:9px 12px 7px;font:inherit;font-size:12.5px;font-weight:500;color:var(--lp-fg2);cursor:pointer}
      .lp-tab:hover{background:rgba(127,127,127,.08);color:var(--lp-fg)}
      .lp-tab.on{color:var(--lp-brand);border-bottom-color:var(--lp-brand);font-weight:650}
      .lp-tab:focus-visible{outline:2px solid var(--lp-brand);outline-offset:-2px}
      .lp-body{flex:1;min-height:0;overflow:auto;padding:14px 20px 26px;scrollbar-gutter:stable}
      .lp-stack{display:flex;flex-direction:column;gap:13px;width:100%;max-width:1060px;margin:0 auto}
      .lp-card{padding:13px 15px 15px;border:1px solid var(--lp-line);border-radius:12px;background:var(--lp-bg1);box-shadow:0 1px 2px rgba(16,24,40,.04);min-width:0}
      .lp-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;font-weight:660;margin-bottom:8px}
      .lp-card-body{display:flex;flex-direction:column;gap:8px;min-width:0}
      .lp-row{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;font-size:12.5px}
      .lp-row>span:first-child{color:var(--lp-fg3)}
      .lp-row>span:last-child{word-break:break-all}
      .lp-note{font-size:12px;color:var(--lp-fg2)}
      .lp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
      .lp-empty{padding:12px 0;font-size:12px;color:var(--lp-fg3)}
      .lp-pending{display:flex;flex-wrap:wrap;gap:6px}
      .lp-chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid rgba(168,106,0,.35);background:rgba(168,106,0,.08);color:var(--lp-warn);font-size:11px}
      .lp-questions{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--lp-fg2)}
      .lp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
      .lp-btn{appearance:none;border:1px solid var(--lp-line-strong);border-radius:8px;background:var(--lp-bg);color:var(--lp-fg);font:inherit;font-size:12.5px;font-weight:550;padding:6px 12px;cursor:pointer}
      .lp-btn:hover{background:var(--lp-bg2)}
      .lp-btn:focus-visible{outline:2px solid var(--lp-brand);outline-offset:1px}
      .lp-btn.primary{border-color:var(--lp-brand);background:var(--lp-brand);color:#fff}
      .lp-btn.primary:hover{filter:brightness(1.06)}
      .lp-btn:disabled{opacity:.55;cursor:default}
      .lp-btn.quiet{border-color:transparent;background:transparent;color:var(--lp-fg2);padding:2px 6px}
      .lp-files{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;min-height:420px}
      .lp-file-list{display:flex;flex-direction:column;gap:6px;min-width:0}
      .lp-file{appearance:none;width:100%;text-align:left;border:1px solid var(--lp-line);border-radius:9px;background:var(--lp-bg);color:var(--lp-fg);font:inherit;padding:8px 10px;cursor:pointer}
      .lp-file:hover{background:var(--lp-bg2)}
      .lp-file.on{border-color:var(--lp-brand);background:rgba(47,111,237,.07)}
      .lp-file:focus-visible{outline:2px solid var(--lp-brand);outline-offset:1px}
      .lp-file-name{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px;font-weight:600}
      .lp-file-meta{margin-top:2px;font-size:11px;color:var(--lp-fg3)}
      .lp-badge{display:inline-flex;align-items:center;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(168,106,0,.1);color:var(--lp-warn);white-space:nowrap}
      .lp-editor{display:flex;flex-direction:column;gap:9px;min-width:0}
      .lp-editor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .lp-editor-title{font-size:13.5px;font-weight:660}
      .lp-editor-meta{font-size:11px;color:var(--lp-fg3);white-space:nowrap}
      .lp-dirty{color:var(--lp-warn);font-weight:600}
      .lp-textarea{width:100%;min-height:330px;resize:vertical;border:1px solid var(--lp-line-strong);border-radius:10px;background:var(--lp-bg);color:var(--lp-fg);font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 13px;outline:none}
      .lp-textarea:focus{border-color:var(--lp-brand);box-shadow:0 0 0 3px rgba(47,111,237,.14)}
      .lp-textarea[readonly]{opacity:.7}
      .lp-inline-error{font-size:12px;color:var(--lp-bad);display:flex;align-items:center;justify-content:space-between;gap:10px}
      .lp-toast{position:sticky;bottom:0;margin-top:10px;align-self:center;padding:7px 14px;border-radius:999px;background:var(--lp-fg);color:var(--lp-bg);font-size:12px;box-shadow:0 6px 20px rgba(16,24,40,.18)}
      .lp-history{display:flex;flex-direction:column;gap:6px}
      .lp-history-row{display:grid;grid-template-columns:58px minmax(0,1fr) auto auto;align-items:center;gap:10px;width:100%;text-align:left;border:1px solid var(--lp-line);border-radius:9px;background:var(--lp-bg);color:var(--lp-fg);font:inherit;padding:7px 10px;cursor:pointer}
      .lp-history-row:hover{background:var(--lp-bg2)}
      .lp-history-row.on{border-color:var(--lp-brand);background:rgba(47,111,237,.07)}
      .lp-history-row:focus-visible{outline:2px solid var(--lp-brand);outline-offset:1px}
      .lp-history-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:650}
      .lp-history-source{font-size:12.5px;color:var(--lp-fg2);min-width:0}
      .lp-history-time{font-size:11px;color:var(--lp-fg3);white-space:nowrap}
      .lp-diff-direction{margin:2px 0 10px;font-size:12.5px;color:var(--lp-fg2)}
      .lp-diff{display:flex;flex-direction:column;gap:9px}
      .lp-diff-file{border:1px solid var(--lp-line);border-radius:9px;background:var(--lp-bg);overflow:hidden}
      .lp-diff-file-head{display:flex;align-items:center;gap:10px;padding:7px 10px;border-bottom:1px solid var(--lp-line);background:var(--lp-bg1)}
      .lp-diff-file-name{font-size:12.5px;font-weight:600;flex:1;min-width:0;word-break:break-all}
      .lp-diff-stat{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:var(--lp-fg2);white-space:nowrap}
      .lp-diff-none{font-size:11.5px;color:var(--lp-fg3);white-space:nowrap}
      .lp-diff-hunks{display:flex;flex-direction:column}
      .lp-hunk{border-top:1px dashed var(--lp-line)}
      .lp-hunk:first-child{border-top:0}
      .lp-hunk-head{padding:4px 10px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--lp-fg3);background:var(--lp-bg1)}
      .lp-diff-line{display:flex;gap:8px;padding:1px 10px;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
      .lp-diff-line.same{color:var(--lp-fg2)}
      .lp-diff-line.add{background:rgba(26,127,75,.1);color:var(--lp-ok)}
      .lp-diff-line.remove{background:rgba(196,59,59,.1);color:var(--lp-bad)}
      .lp-diff-marker{flex:none;width:8px;text-align:center;opacity:.75}
      @media (max-width:760px){.lp-files{grid-template-columns:1fr}.lp-file-list{flex-direction:row;overflow-x:auto;padding-bottom:4px}.lp-file{min-width:180px}.lp-dots{max-width:100%}.lp-head{flex-direction:column;gap:8px}.lp-history-row{grid-template-columns:58px minmax(0,1fr) auto}.lp-history-time{display:none}}
    `

    async function api(path, options) {
      const request = { cache: 'no-store', ...options }
      if (options !== undefined && options.body !== undefined) {
        request.headers = { 'content-type': 'application/json' }
      }
      const response = await fetch(API + path, request)
      let data
      try {
        data = await response.json()
      } catch {
        throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'HTTP_ERROR' })
      }
      if (!response.ok || data.ok === false) {
        throw Object.assign(new Error(data.error || `HTTP ${response.status}`), {
          code: data.code, hint: data.hint, status: response.status,
        })
      }
      return data
    }

    function byteLength(text) {
      try {
        return new TextEncoder().encode(text).length
      } catch {
        return text.length
      }
    }

    function formatBytes(value) {
      return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`
    }

    function nonBlankCount(snapshot) {
      if (snapshot === null) return 0
      return FILES.filter(name => {
        const detail = snapshot.fileDetails?.[name]
        return detail !== undefined && detail.blank === false
      }).length
    }

    function Icon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true,
      },
        h('circle', { cx: 12, cy: 8, r: 4 }),
        h('path', { d: 'M4.5 20a7.5 7.5 0 0 1 15 0' }),
      )
    }

    function LaputaPanel() {
      const [tab, setTab] = useState('overview')
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [selected, setSelected] = useState('IDENTITY.MD')
      const [editor, setEditor] = useState({
        name: '', content: '', loaded: '', digest: '', exists: false,
        loading: false, saving: false, error: '', conflict: false,
      })
      const [history, setHistory] = useState(null)
      const [historyError, setHistoryError] = useState('')
      const [historyLoading, setHistoryLoading] = useState(false)
      const [selectedRevision, setSelectedRevision] = useState(null)
      const [revisionView, setRevisionView] = useState(null)
      const [revisionError, setRevisionError] = useState('')
      const [rollbackBusy, setRollbackBusy] = useState(false)
      const noticeTimer = useRef()
      const revisionSeq = useRef(0)

      const flash = useCallback(message => {
        setNotice(message)
        if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 3200)
      }, [])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('/status')
          setSnapshot(data)
          setError('')
          return data
        } catch (failure) {
          setError(failure.message)
          return null
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { void refresh() }, [refresh])

      const openFile = useCallback(async name => {
        setSelected(name)
        setEditor(previous => ({
          ...previous, name, loading: true, saving: false, error: '', conflict: false,
        }))
        try {
          const data = await api(`/file?name=${encodeURIComponent(name)}`)
          setEditor({
            name,
            content: data.content,
            loaded: data.content,
            digest: data.digest,
            exists: data.exists,
            loading: false,
            saving: false,
            error: '',
            conflict: false,
          })
        } catch (failure) {
          setEditor(previous => ({
            ...previous, name, loading: false, saving: false,
            error: failure.message, conflict: false,
          }))
        }
      }, [])

      useEffect(() => {
        if (tab === 'files' && editor.name === '') void openFile(selected)
      }, [tab, editor.name, openFile, selected])

      const reload = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('/reload', { method: 'POST' })
          setSnapshot(data)
          setError('')
          flash('已重新读取人格文件')
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [flash])

      const dirty = editor.content !== editor.loaded

      const save = useCallback(async () => {
        if (editor.saving || editor.loading || editor.name === '' || !dirty) return
        const clearingCore = CORE.includes(editor.name)
          && editor.content.trim() === ''
          && editor.loaded.trim() !== ''
        if (clearingCore && !window.confirm('保存后人格将回到未初始化状态，对话会重新进入引导。继续？')) return
        setEditor(previous => ({ ...previous, saving: true, error: '', conflict: false }))
        try {
          const data = await api('/file', {
            method: 'POST',
            body: JSON.stringify({
              name: editor.name,
              content: editor.content,
              expectedDigest: editor.digest,
            }),
          })
          setEditor(previous => ({
            ...previous,
            loaded: previous.content,
            digest: data.digest,
            exists: true,
            saving: false,
            error: '',
            conflict: false,
          }))
          const status = data.status
          if (status !== undefined && status.stateDirectory !== undefined && status.stateDirectory !== null) {
            flash(`${editor.name} 已保存草稿；发布后生效`)
          } else if (status !== undefined && status.initialized === false) {
            const pendingFiles = status.pendingFiles || []
            flash(pendingFiles.length === 0 ? '已保存' : `已保存；还需填写 ${pendingFiles.join('、')}`)
          } else {
            flash(`${editor.name} 已保存；下一轮对话生效`)
          }
          await refresh()
        } catch (failure) {
          const conflict = failure.code === 'FILE_CHANGED'
          setEditor(previous => ({
            ...previous,
            saving: false,
            conflict,
            error: conflict
              ? '文件已被其他方式修改。请重新加载后再保存。'
              : failure.message,
          }))
        }
      }, [dirty, editor, flash, refresh])

      const revert = useCallback(() => {
        setEditor(previous => ({
          ...previous, content: previous.loaded, error: '', conflict: false,
        }))
      }, [])

      const status = snapshot?.status
      const enabled = status?.enabled === true
      const initialized = status?.initialized === true
      const hasStore = status?.stateDirectory !== undefined && status?.stateDirectory !== null
      const revisionPending = status?.revisionPending === true
      const draftInitialized = status?.draftInitialized ?? initialized
      const pending = (hasStore ? status?.draftPendingFiles : status?.pendingFiles) || []

      const publish = useCallback(async () => {
        if (busy || status === undefined || status.revisionPending !== true) return
        setBusy(true)
        try {
          const data = await api('/publish', {
            method: 'POST',
            body: JSON.stringify({
              expectedBaseRevision: status.revision ?? null,
              expectedDraftDigest: status.draftDigest ?? '',
            }),
          })
          setSnapshot(data)
          setError('')
          flash(`已发布 r${data.revision}；新会话生效`)
        } catch (failure) {
          await refresh()
          setError(failure.code === 'REVISION_CONFLICT'
            ? '版本已在其他位置变化，请刷新状态后再发布。'
            : failure.message)
        } finally {
          setBusy(false)
        }
      }, [busy, flash, refresh, status])

      const loadHistory = useCallback(async () => {
        setHistoryLoading(true)
        try {
          const data = await api('/revisions')
          setHistory(data)
          setHistoryError('')
          return data
        } catch (failure) {
          setHistoryError(failure.message)
          return null
        } finally {
          setHistoryLoading(false)
        }
      }, [])

      const openRevision = useCallback(async revision => {
        revisionSeq.current += 1
        const seq = revisionSeq.current
        setSelectedRevision(revision)
        setRevisionError('')
        try {
          const data = await api(`/revision?revision=${revision}`)
          if (revisionSeq.current !== seq) return null
          setRevisionView(data)
          return data
        } catch (failure) {
          if (revisionSeq.current !== seq) return null
          setRevisionView(null)
          setRevisionError(failure.message)
          if (failure.status === 404) {
            setSelectedRevision(null)
            await loadHistory()
          }
          return null
        }
      }, [loadHistory])

      const rollback = useCallback(async target => {
        if (rollbackBusy || status === undefined) return
        const message = status.revisionPending === true
          ? `回滚会把草稿覆盖为 r${target} 的内容，未发布的修改将丢失。继续？`
          : `回滚会创建新版本并恢复 r${target} 的内容。继续？`
        if (!window.confirm(message)) return
        setRollbackBusy(true)
        try {
          const data = await api('/rollback', {
            method: 'POST',
            body: JSON.stringify({
              targetRevision: target,
              expectedBaseRevision: status.revision ?? null,
              expectedDraftDigest: status.draftDigest ?? '',
            }),
          })
          setSnapshot(data)
          setError('')
          flash(data.published === true
            ? `已回滚到 r${target}，生成 r${data.revision}；新会话生效`
            : '目标版本与当前内容一致，未生成新版本')
          await loadHistory()
          if (typeof data.revision === 'number') await openRevision(data.revision)
        } catch (failure) {
          if (failure.code === 'REVISION_CONFLICT') {
            await refresh()
            await loadHistory()
            setError('版本已在其他位置变化，请刷新后再回滚。')
          } else {
            setRevisionError(failure.message)
            if (failure.status === 404) await loadHistory()
          }
        } finally {
          setRollbackBusy(false)
        }
      }, [flash, loadHistory, openRevision, refresh, rollbackBusy, status])

      const dots = [
        h('span', { key: 'enabled', className: `lp-dot ${enabled ? 'ok' : 'warn'}` }, enabled ? '注入已启用' : '未启用'),
        h('span', { key: 'init', className: `lp-dot ${initialized ? 'ok' : 'warn'}` }, initialized ? '已初始化' : '未初始化'),
        h('span', { key: 'files', className: 'lp-dot' }, `${nonBlankCount(snapshot)} / 6 文件`),
        h('span', { key: 'chars', className: 'lp-dot' }, `${status?.chars ?? 0} 字符`),
      ]

      const tabs = hasStore
        ? [['overview', '概览'], ['files', '文件'], ['history', '版本']]
        : [['overview', '概览'], ['files', '文件']]

      const tabbar = h('div', { className: 'lp-tabs', role: 'tablist', 'aria-label': '人格面板导航' },
        tabs.map(([key, label]) =>
          h('button', {
            key,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === key,
            className: `lp-tab ${tab === key ? 'on' : ''}`,
            onClick: () => {
              setTab(key)
              if (key === 'history') return loadHistory()
              return undefined
            },
          }, label)))

      const overview = () => {
        const current = h('section', { className: 'lp-card', key: 'current' },
          h('div', { className: 'lp-card-title' }, '当前人格'),
          h('div', { className: 'lp-card-body' },
            h('div', { className: 'lp-row' }, h('span', null, 'personaId'), h('span', { className: 'lp-mono' }, status?.personaId ?? '—')),
            h('div', { className: 'lp-row' }, h('span', null, '目录'), h('span', { className: 'lp-mono' }, status?.directory ?? '—')),
            h('div', { className: 'lp-row' }, h('span', null, '来源'), h('span', null, status?.customSource ? 'sourceDir' : '$DSH_HOME/laputa')),
            hasStore
              ? h('div', { className: 'lp-row' },
                h('span', null, '版本'),
                h('span', { className: 'lp-mono' },
                  status.revision === null
                    ? '未发布'
                    : `r${status.revision} · 共 ${status.revisionCount ?? 0} 个`))
              : null,
            hasStore
              ? h('div', { className: 'lp-row' },
                h('span', null, '保留策略'),
                h('span', null, status.revisionRetention > 0
                  ? `保留最近 ${status.revisionRetention} 个版本`
                  : '保留全部版本'))
              : null,
            hasStore
              ? h('div', { className: 'lp-row' },
                h('span', null, '草稿'),
                h('span', null, revisionPending ? '有未发布修改' : '已同步'))
              : null,
            h('div', { className: 'lp-row' }, h('span', null, '指纹'), h('span', { className: 'lp-mono' }, status === undefined || status.fingerprint === '' ? '—' : status.fingerprint.slice(0, 12))),
            h('div', { className: 'lp-row' }, h('span', null, '最近读取'), h('span', null, status?.lastLoadedAt ?? '—')),
            h('div', { className: 'lp-actions' },
              hasStore
                ? h('button', {
                  type: 'button',
                  className: 'lp-btn primary',
                  disabled: busy || !revisionPending,
                  onClick: publish,
                }, busy ? '处理中…' : '发布草稿')
                : null,
              h('button', { type: 'button', className: 'lp-btn', disabled: busy, onClick: reload }, busy ? '读取中…' : '重新读取'))))

        const initBody = []
        if (status === undefined) {
          initBody.push(h('p', { className: 'lp-empty', key: 'empty' }, '尚未读取到人格状态。'))
        } else if (!enabled) {
          initBody.push(h('p', { className: 'lp-note', key: 'disabled' }, '插件当前未启用：内容仍可编辑，但保存后不会注入提示词。启用或切换人格请使用 npm run setup:laputa。'))
        }
        if (status !== undefined && initialized) {
          initBody.push(h('p', { className: 'lp-note', key: 'ok' }, hasStore
            ? `${nonBlankCount(snapshot)} / 6 文件非空；保存写入草稿，发布后对新会话生效。`
            : `${nonBlankCount(snapshot)} / 6 文件非空；保存后下一轮对话生效。`))
        } else if (status !== undefined && draftInitialized) {
          initBody.push(h('p', { className: 'lp-note', key: 'draft-ready' }, hasStore
            ? '草稿已填写；发布后对新会话生效。'
            : '草稿已填写。'))
        } else if (status !== undefined) {
          initBody.push(h('div', { className: 'lp-pending', key: 'pending' },
            (pending.length > 0 ? pending : ['IDENTITY.MD', 'MISSION.MD']).map(name =>
              h('span', { className: 'lp-chip', key: name }, name))))
          initBody.push(h('ol', { className: 'lp-questions', key: 'questions' },
            h('li', null, '我是谁？（IDENTITY：可以是名字，也可以是名字之外的身份、语气、价值观）'),
            h('li', null, '我的使命是什么？（MISSION）')))
          initBody.push(h('p', { className: 'lp-note', key: 'advanced' }, '也可以补充 RELATIONSHIP（如何相处）与 REDLINE（硬边界）；DREAM / DARK 由 agent 在对话中生成。'))
          initBody.push(h('div', { className: 'lp-actions', key: 'go' },
            h('button', {
              type: 'button',
              className: 'lp-btn primary',
              onClick: () => {
                const first = pending.find(name => CORE.includes(name)) ?? 'IDENTITY.MD'
                setTab('files')
                void openFile(first)
              },
            }, '去填写')))
        }
        const init = h('section', { className: 'lp-card', key: 'init' },
          h('div', { className: 'lp-card-title' }, '初始化状态',
            h('span', { className: `lp-dot ${initialized ? 'ok' : 'warn'}` }, initialized ? '已初始化' : '未初始化')),
          h('div', { className: 'lp-card-body' }, ...initBody))

        const health = h('section', { className: 'lp-card', key: 'health' },
          h('div', { className: 'lp-card-title' }, '错误与变更'),
          h('div', { className: 'lp-card-body' },
            status?.lastError !== undefined
              ? h('p', { className: 'lp-inline-error' }, status.lastError)
              : h('p', { className: 'lp-mono' }, '未记录错误'),
            status?.pendingChanges === true
              ? h('p', { className: 'lp-note' }, hasStore
                ? '草稿有未发布修改；发布后对新会话生效。'
                : '磁盘上的人格文件已变化，下一轮对话会自动重新读取。')
              : h('p', { className: 'lp-note' }, hasStore
                ? '草稿与当前版本一致。'
                : '缓存与磁盘一致。'),
            h('p', { className: 'lp-note' }, hasStore
              ? '保存只改草稿；发布不会改变正在运行的会话。'
              : '写入只会替换单个已知文件；启用状态仍由 profile 控制。')))

        return h('div', { className: 'lp-stack' }, current, init, health)
      }

      const files = () => {
        const list = h('div', { className: 'lp-file-list', role: 'list' },
          FILES.map(name => {
            const detail = snapshot?.fileDetails?.[name]
            const isPending = pending.includes(name) || detail?.blank === true
            return h('button', {
              key: name,
              type: 'button',
              role: 'listitem',
              className: `lp-file ${selected === name ? 'on' : ''}`,
              onClick: () => { void openFile(name) },
            },
              h('span', { className: 'lp-file-name' },
                h('span', null, name),
                isPending ? h('span', { className: 'lp-badge' }, '待填写') : null),
              h('span', { className: 'lp-file-meta' },
                detail === undefined ? '未读取' : `${detail.exists ? formatBytes(detail.bytes) : '缺失'}${detail.blank ? ' · 空白' : ''}`))
          }))

        const coreWarning = CORE.includes(editor.name)
          ? h('p', { className: 'lp-note' }, '清空此文件会让人格回到未初始化状态。')
          : null

        const editorView = h('div', { className: 'lp-editor' },
          h('div', { className: 'lp-editor-head' },
            h('div', null,
              h('div', { className: 'lp-editor-title' }, editor.name || selected),
              h('div', { className: 'lp-editor-meta' },
                `${byteLength(editor.content)} B · ${editor.content.length} 字符`,
                dirty ? h('span', { className: 'lp-dirty' }, ' · 未保存') : null)),
            h('div', { className: 'lp-actions' },
              h('button', {
                type: 'button', className: 'lp-btn primary',
                disabled: editor.saving || editor.loading || !dirty, onClick: save,
              }, editor.saving ? '保存中…' : '保存'),
              h('button', {
                type: 'button', className: 'lp-btn',
                disabled: editor.saving || !dirty, onClick: revert,
              }, '还原'))),
          editor.loading
            ? h('p', { className: 'lp-empty' }, '正在加载…')
            : h('textarea', {
              className: 'lp-textarea',
              value: editor.content,
              spellCheck: false,
              'aria-label': `编辑 ${editor.name || selected}`,
              placeholder: '此文件还没有内容。可以直接填写，或在对话里让 agent 引导。',
              onChange: event => setEditor(previous => ({ ...previous, content: event.target.value })),
              onKeyDown: event => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void save()
                }
              },
            }),
          coreWarning,
          editor.error
            ? h('div', { className: 'lp-inline-error', role: 'alert' },
              h('span', null, editor.error),
              editor.conflict
                ? h('button', { type: 'button', className: 'lp-btn quiet', onClick: () => { void openFile(editor.name) } }, '重新加载此文件')
                : null)
            : null,
          h('p', { className: 'lp-note' }, hasStore
            ? '保存只替换当前文件的草稿；发布后新会话生效，运行中的会话保持不变。'
            : '保存只替换当前文件；其它文件不会被改动。'))

        return h('div', { className: 'lp-stack' },
          h('section', { className: 'lp-card' },
            h('div', { className: 'lp-card-title' }, '人格文件',
              h('span', { className: 'lp-note' }, '六个已知文件名 · 单文件与总字符受限')),
            h('div', { className: 'lp-files' }, list, editorView)))
      }

      const ACTOR_LABELS = { panel: '面板', tool: '助手工具', command: '命令', bootstrap: '首次初始化' }
      const sourceLabel = source => source
        ? `${ACTOR_LABELS[source.actor] ?? source.actor}${source.note ? ` · ${source.note}` : ''}`
        : null

      const historyView = () => {
        const revisions = history?.revisions ?? []
        const ordered = [...revisions].sort((left, right) => right.revision - left.revision)
        const current = history?.current ?? status?.revision ?? null

        const list = ordered.length === 0
          ? h('p', { className: 'lp-empty' }, historyLoading ? '正在加载版本历史…' : '还没有发布任何版本。')
          : h('div', { className: 'lp-history' }, ...ordered.map(entry => {
            const source = entry.restoredFrom !== null
              ? `回滚自 r${entry.restoredFrom}`
              : entry.parent === null
                ? '初始版本'
                : `发布基于 r${entry.parent}`
            return h('button', {
              key: entry.revision,
              type: 'button',
              className: `lp-history-row ${selectedRevision === entry.revision ? 'on' : ''}`,
              onClick: () => openRevision(entry.revision),
            },
              h('span', { className: 'lp-history-id' }, `r${entry.revision}`),
              h('span', { className: 'lp-history-source' }, source),
              sourceLabel(entry.source) ? h('span', { className: 'lp-history-source' }, sourceLabel(entry.source)) : null,
              h('span', { className: 'lp-history-time' }, entry.createdAt),
              entry.revision === current ? h('span', { className: 'lp-badge' }, '当前') : null)
          }))

        const historyCard = h('section', { className: 'lp-card' },
          h('div', { className: 'lp-card-title' }, '版本历史',
            historyLoading ? h('span', { className: 'lp-note' }, '加载中…') : null),
          historyError ? h('p', { className: 'lp-inline-error', role: 'alert' }, historyError) : null,
          list)

        let detail = null
        if (revisionView !== null) {
          const target = revisionView.revision
          const live = revisionView.liveRevision
          const direction = revisionView.sameAsLive
            ? '此版本就是当前 live 版本。'
            : live === null
              ? `差异方向：尚无 live 版本 → r${target}`
              : `差异方向：当前 r${live} → r${target}（回滚后）`
          const files = revisionView.diff?.files ?? []
          detail = h('section', { className: 'lp-card lp-revision-detail' },
            h('div', { className: 'lp-card-title' },
              h('span', null, `r${target}`),
              revisionView.sameAsLive
                ? h('span', { className: 'lp-note' }, 'live')
                : h('span', { className: 'lp-note' }, `目标 r${target}`)),
            h('p', { className: 'lp-diff-direction' }, direction),
            sourceLabel(revisionView.manifest?.source)
              ? h('p', { className: 'lp-note' }, `更新来源：${sourceLabel(revisionView.manifest.source)}`) : null,
            revisionError ? h('p', { className: 'lp-inline-error', role: 'alert' }, revisionError) : null,
            files.length === 0
              ? h('p', { className: 'lp-empty' }, '没有可显示的差异。')
              : h('div', { className: 'lp-diff' }, ...files.map(file => {
                const changed = file.changed === true
                return h('div', { className: 'lp-diff-file', key: file.name },
                  h('div', { className: 'lp-diff-file-head' },
                    h('span', { className: 'lp-diff-file-name' }, file.name),
                    changed
                      ? h('span', { className: 'lp-diff-stat' }, `+${file.added} -${file.removed}`)
                      : h('span', { className: 'lp-diff-none' }, '无变化'),
                    file.truncated
                      ? h('span', { className: 'lp-badge' }, '整文件已变化（超出差异上限）')
                      : null),
                  changed && file.hunks.length > 0
                    ? h('div', { className: 'lp-diff-hunks' }, ...file.hunks.map((hunk, hunkIndex) =>
                      h('div', { className: 'lp-hunk', key: hunkIndex },
                        h('div', { className: 'lp-hunk-head' },
                          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
                        ...hunk.lines.map((line, lineIndex) =>
                          h('div', {
                            key: lineIndex,
                            className: `lp-diff-line ${line.kind}`,
                          },
                            h('span', { className: 'lp-diff-marker' },
                              line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '),
                            line.text)))))
                    : null)
              })),
            revisionView.sameAsLive
              ? null
              : h('div', { className: 'lp-actions' },
                h('button', {
                  type: 'button',
                  className: 'lp-btn primary',
                  disabled: rollbackBusy,
                  onClick: () => rollback(target),
                }, rollbackBusy ? '回滚中…' : `回滚到 r${target}`)))
        } else if (revisionError) {
          detail = h('p', { className: 'lp-inline-error', role: 'alert' }, revisionError)
        }

        return h('div', { className: 'lp-stack' }, historyCard, detail)
      }

      return h('main', { className: 'laputa-panel' },
        h('style', null, PANEL_CSS),
        h('header', { className: 'lp-head' },
          h('div', null,
            h('p', { className: 'lp-kicker' }, 'DSH · 人格'),
            h('h1', null, '人格'),
            h('p', { className: 'lp-sub' }, '检查人格状态，编辑六份人格文档。保存写入草稿，发布后对新会话生效。')),
          h('div', { className: 'lp-dots' }, ...dots)),
        h('div', { className: 'lp-alerts' },
          error
            ? h('div', { className: 'lp-alert danger', role: 'alert' },
              h('span', null, error),
              h('button', { type: 'button', className: 'lp-btn quiet', onClick: () => setError('') }, '关闭提示'))
            : null,
          status !== undefined && !enabled
            ? h('div', { className: 'lp-alert warn', role: 'status' }, h('span', null, '人格插件当前未启用；保存只会修改文件，不会注入提示词。'))
            : null),
        tabbar,
        h('div', { className: 'lp-body', role: 'tabpanel' },
          tab === 'overview' ? overview() : tab === 'files' ? files() : historyView(),
          notice ? h('div', { className: 'lp-toast', role: 'status' }, notice) : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'laputa', inject: () => ({}) }, LaputaPanel,
        ))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'laputa', order: 14, label: () => '人格' }, Icon,
        ))
      },
    }
  },
})
