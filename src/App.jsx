import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

/**
 * Read-only database console.
 *
 * Talks to two endpoints on the TPRM backend:
 *   POST /admin/schema - topology (Aurora cluster + tables, DynamoDB tables)
 *   POST /admin/query  - run a SELECT
 *
 * The backend refuses to write (READ ONLY transaction, always rolled back), so
 * nothing typed here can modify or delete data.
 */

const API_BASE_DEFAULT = 'https://sczs2nm4fl.execute-api.us-east-2.amazonaws.com'
const API_BASE = (localStorage.getItem('tprm_api_base') || API_BASE_DEFAULT).replace(/\/+$/, '')

const STARTER_SQL = 'SELECT * FROM vendors ORDER BY legal_name;'

/**
 * The cluster auto-pauses after 5 idle minutes and a full wake can take longer
 * than API Gateway will hold a request open. The server therefore answers
 * 503 database_resuming immediately rather than hanging, and we retry here.
 */
const RESUME_RETRIES = 6
const RESUME_WAIT_MS = 5000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * POST that transparently rides out a waking database.
 * onWaking is called so the UI can say what is happening instead of just spinning.
 */
async function postWithResume(path, body, onWaking) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await res.json().catch(() => ({}))

    if (res.status === 503 && payload.error === 'database_resuming' && attempt < RESUME_RETRIES) {
      onWaking?.(attempt + 1)
      await sleep(RESUME_WAIT_MS)
      continue
    }
    if (!res.ok) throw new Error(payload.message || `HTTP ${res.status}`)
    return payload
  }
}

/* ---------------------------------------------------------------------------
 * Export helpers
 *
 * No spreadsheet library on purpose. The maintained SheetJS build is not on
 * npm, and the version that is has published CVEs - not worth it to produce a
 * file Excel already opens. CSV and TSV both open natively; the clipboard
 * button is usually the fastest route into a sheet.
 * ------------------------------------------------------------------------- */

/** RFC 4180: wrap in quotes if the value contains a quote, delimiter or newline. */
function csvCell(value, delimiter) {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function toDelimited(columns, rows, delimiter) {
  const head = columns.map((c) => csvCell(c, delimiter)).join(delimiter)
  const body = rows.map((r) => columns.map((c) => csvCell(r[c], delimiter)).join(delimiter))
  return [head, ...body].join('\r\n')
}

function download(filename, text, mime) {
  const blob = new Blob([`﻿${text}`], { type: mime })   // BOM so Excel reads UTF-8
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 0)
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

/* ------------------------------------------------------------------------- */

function TableNode({ table, store, onPick }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="tree-table">
      <div className="tree-row">
        <button className="tree-toggle" onClick={() => setOpen(!open)} aria-label="Toggle columns">
          {open ? '▾' : '▸'}
        </button>
        <button
          className={`tree-name${store.queryable ? ' clickable' : ''}`}
          onClick={() => store.queryable && onPick(table.name)}
          title={store.queryable ? 'Click to query this table' : 'Not SQL-queryable'}
        >
          {table.name}
        </button>
        <span className="tree-count">
          {table.rowCount === null || table.rowCount === undefined ? '' : `${table.rowCount} rows`}
        </span>
      </div>
      {open && (
        <ul className="tree-cols">
          {table.columns.length === 0 && <li className="muted">no column info</li>}
          {table.columns.map((c) => (
            <li key={c.name}>
              <span className="col-name">{c.name}</span>
              <span className="col-type">{c.type}</span>
              {c.nullable === false && <span className="col-flag">not null</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function StoreNode({ store, onPick }) {
  const cluster = store.cluster
  return (
    <div className="store">
      <div className="store-head">
        <span className={`badge ${store.kind}`}>{store.kind === 'aurora' ? 'SQL' : 'NoSQL'}</span>
        <span className="store-engine">{store.engine}</span>
      </div>

      {cluster && (
        <div className="cluster-meta">
          <div className="cluster-id">{cluster.identifier}</div>
          <div className="chips">
            {/* paused === null means CloudWatch had nothing to say, which is
                different from knowing it is paused. Do not claim either way. */}
            {cluster.paused === null ? (
              <span className="chip">capacity unknown</span>
            ) : (
              <span className={`chip ${cluster.paused ? 'warn' : 'ok'}`}>
                {cluster.paused ? 'paused' : `${cluster.currentCapacity} ACU`}
              </span>
            )}
            <span className="chip">{cluster.status}</span>
            {cluster.engineVersion && <span className="chip">v{cluster.engineVersion}</span>}
            <span className="chip">
              {cluster.minAcu}–{cluster.maxAcu} ACU
            </span>
          </div>
        </div>
      )}

      {store.note && <div className="store-note">{store.note}</div>}
      {store.error && <div className="store-note err">{store.error}</div>}

      {store.databases.map((db) => (
        <div key={db.name} className="db">
          <div className="db-name">{db.name}</div>
          <ul className="tree">
            {db.tables.length === 0 && <li className="muted">no tables</li>}
            {db.tables.map((t) => (
              <TableNode key={t.name} table={t} store={store} onPick={onPick} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const [schema, setSchema] = useState(null)
  const [schemaError, setSchemaError] = useState(null)
  const [loadingSchema, setLoadingSchema] = useState(true)
  const [slowHint, setSlowHint] = useState(false)

  const [sql, setSql] = useState(STARTER_SQL)
  const [result, setResult] = useState(null)
  const [queryError, setQueryError] = useState(null)
  const [running, setRunning] = useState(false)
  const [waking, setWaking] = useState(false)
  const [elapsed, setElapsed] = useState(null)
  const [copied, setCopied] = useState(false)

  const editorRef = useRef(null)

  const loadSchema = useCallback(async () => {
    setLoadingSchema(true)
    setSchemaError(null)
    setSlowHint(false)
    // Say what is happening rather than letting the page look frozen: either the
    // request is merely slow, or the server told us the cluster is waking.
    const hint = setTimeout(() => setSlowHint(true), 2500)
    try {
      setSchema(await postWithResume('/admin/schema', {}, () => setSlowHint(true)))
    } catch (err) {
      setSchemaError(err.message)
    } finally {
      clearTimeout(hint)
      setSlowHint(false)
      setLoadingSchema(false)
    }
  }, [])

  useEffect(() => { loadSchema() }, [loadSchema])

  const runQuery = useCallback(async () => {
    if (running || !sql.trim()) return
    setRunning(true)
    setQueryError(null)
    setElapsed(null)
    setWaking(false)
    const started = performance.now()
    try {
      setResult(await postWithResume('/admin/query', { sql }, () => setWaking(true)))
    } catch (err) {
      setQueryError(err.message)
      setResult(null)
    } finally {
      setElapsed(Math.round(performance.now() - started))
      setWaking(false)
      setRunning(false)
    }
  }, [sql, running])

  // Ctrl/Cmd+Enter runs, like every other SQL client.
  const onEditorKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      runQuery()
    }
  }

  const pickTable = (name) => {
    const next = `SELECT * FROM "${name}" LIMIT 50;`
    setSql(next)
    editorRef.current?.focus()
  }

  const copyForExcel = async () => {
    if (!result) return
    try {
      await navigator.clipboard.writeText(toDelimited(result.columns, result.rows, '\t'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setQueryError('Clipboard blocked by the browser - use Download TSV instead.')
    }
  }

  const hasRows = result && result.rows.length > 0

  return (
    <div className="console">
      <header className="top">
        <div>
          <h1>Database console</h1>
          <p className="sub">
            Read-only. Writes are rejected by the server, so nothing here can change your data.
          </p>
        </div>
        <button className="btn ghost" onClick={loadSchema} disabled={loadingSchema}>
          {loadingSchema ? 'Loading…' : 'Refresh'}
        </button>
      </header>

      <div className="layout">
        {/* ---------------- topology ---------------- */}
        <aside className="sidebar">
          <h2>Topology</h2>

          {loadingSchema && (
            <div className="loading">
              Loading schema…
              {slowHint && (
                <div className="muted small">
                  The database auto-pauses when idle. Waking it takes about 18 seconds.
                </div>
              )}
            </div>
          )}

          {schemaError && (
            <div className="banner err">
              <strong>Could not load schema.</strong>
              <div className="small">{schemaError}</div>
            </div>
          )}

          {schema?.stores.map((s) => (
            <StoreNode key={s.kind} store={s} onPick={pickTable} />
          ))}
        </aside>

        {/* ---------------- query ---------------- */}
        <main className="main">
          <div className="editor-wrap">
            <textarea
              ref={editorRef}
              className="editor"
              value={sql}
              spellCheck={false}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={onEditorKeyDown}
              placeholder="SELECT * FROM vendors"
            />
            <div className="editor-bar">
              <button className="btn primary" onClick={runQuery} disabled={running}>
                {waking ? 'Waking database…' : running ? 'Running…' : 'Run'}
              </button>
              <span className="muted small">Ctrl/⌘ + Enter</span>
              {waking && (
                <span className="muted small">
                  Auto-paused when idle — this takes a few seconds, retrying automatically.
                </span>
              )}
              {elapsed !== null && <span className="muted small">{elapsed} ms</span>}
              {result && (
                <span className="muted small">
                  {result.rowCount} row{result.rowCount === 1 ? '' : 's'}
                  {result.truncated && ' (truncated)'}
                </span>
              )}
            </div>
          </div>

          {queryError && (
            <div className="banner err">
              <strong>Query failed.</strong>
              <div className="small mono">{queryError}</div>
            </div>
          )}

          {result && result.truncated && (
            <div className="banner warn small">
              Showing the first {result.rows.length} rows. Add a LIMIT to narrow it down.
            </div>
          )}

          {hasRows && (
            <>
              <div className="exports">
                <button className="btn ghost" onClick={() =>
                  download(`query-${stamp()}.csv`, toDelimited(result.columns, result.rows, ','), 'text/csv;charset=utf-8')
                }>Download CSV</button>
                <button className="btn ghost" onClick={() =>
                  download(`query-${stamp()}.tsv`, toDelimited(result.columns, result.rows, '\t'), 'text/tab-separated-values;charset=utf-8')
                }>Download TSV</button>
                <button className="btn ghost" onClick={copyForExcel}>
                  {copied ? 'Copied' : 'Copy for Excel'}
                </button>
                <button className="btn ghost" onClick={() =>
                  download(`query-${stamp()}.json`, JSON.stringify(result.rows, null, 2), 'application/json')
                }>Download JSON</button>
              </div>

              <div className="grid-wrap">
                <table className="grid">
                  <thead>
                    <tr>
                      <th className="rownum">#</th>
                      {result.columns.map((c) => <th key={c}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        <td className="rownum">{i + 1}</td>
                        {result.columns.map((c) => {
                          const v = row[c]
                          const isNull = v === null || v === undefined
                          return (
                            <td key={c} className={isNull ? 'null' : ''}>
                              {isNull ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {result && !hasRows && !queryError && (
            <div className="banner info small">Query ran successfully and returned no rows.</div>
          )}
        </main>
      </div>
    </div>
  )
}
