'use strict'

/**
 * 协作服务端
 *
 * 职责：
 *  1. 实现 y-websocket 兼容的 CRDT 同步协议（sync + awareness），
 *     所有合并由 Yjs CRDT 完成 —— 任何客户端晚同步都不会覆盖别人已确认的内容。
 *  2. 文档更新持久化到磁盘（data/<doc>.yjs）。
 *  3. 修订时间线：手动快照 + 自动快照，恢复历史版本作为一个新的 Yjs 事务
 *     应用到文档上（参与后续 CRDT 合并），并自动生成一条新修订。
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')
const Y = require('yjs')
const encoding = require('lib0/encoding')
const decoding = require('lib0/decoding')
const syncProtocol = require('y-protocols/sync')
const awarenessProtocol = require('y-protocols/awareness')

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data')
const TEXT_KEY = 'quill' // 与前端 y-quill 绑定的 Y.Text 键名
const AUTOSNAPSHOT_INTERVAL = Number(process.env.AUTOSNAPSHOT_INTERVAL || 60 * 1000)
const MAX_REVISIONS = 200

fs.mkdirSync(DATA_DIR, { recursive: true })

/* ------------------------------------------------------------------ *
 *  文档注册表（内存中的活跃文档）
 * ------------------------------------------------------------------ */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

/** docName -> { doc, awareness, conns: Map<ws, Set<number>>, dirty, persistTimer } */
const docs = new Map()

const docFile = (name) => path.join(DATA_DIR, encodeURIComponent(name) + '.yjs')
const revFile = (name) => path.join(DATA_DIR, encodeURIComponent(name) + '.revisions.json')

function persistDoc(docName) {
  const entry = docs.get(docName)
  if (!entry) return
  const update = Y.encodeStateAsUpdate(entry.doc)
  fs.writeFileSync(docFile(docName), Buffer.from(update))
  entry.dirty = false
}

function schedulePersist(docName) {
  const entry = docs.get(docName)
  if (!entry) return
  entry.dirty = true
  clearTimeout(entry.persistTimer)
  entry.persistTimer = setTimeout(() => persistDoc(docName), 2000)
}

function getDoc(docName) {
  let entry = docs.get(docName)
  if (entry) return entry

  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)

  entry = { doc, awareness, conns: new Map(), dirty: false, persistTimer: null, lastSnapshotAt: Date.now() }
  docs.set(docName, entry)

  // 从磁盘恢复
  if (fs.existsSync(docFile(docName))) {
    Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(docFile(docName))))
  }

  // 文档变更 -> 广播给所有连接 + 触发持久化
  doc.on('update', (update) => {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    broadcast(entry, encoding.toUint8Array(encoder))
    schedulePersist(docName)
  })

  // awareness 变更 -> 广播，并跟踪每个连接控制的 clientID（断线时清理）
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin && entry.conns.has(origin)) {
      const controlled = entry.conns.get(origin)
      added.concat(updated).forEach((id) => controlled.add(id))
      removed.forEach((id) => controlled.delete(id))
    }
    const changed = added.concat(updated, removed)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
    broadcast(entry, encoding.toUint8Array(encoder))
  })

  // 自动快照：有变更且距上次快照超过间隔时生成
  entry.autoSnapshotTimer = setInterval(() => {
    if (entry.dirty && Date.now() - entry.lastSnapshotAt >= AUTOSNAPSHOT_INTERVAL) {
      createRevision(docName, '自动快照', 'system')
    }
  }, AUTOSNAPSHOT_INTERVAL)
  entry.autoSnapshotTimer.unref()

  return entry
}

function broadcast(entry, message) {
  for (const conn of entry.conns.keys()) {
    send(conn, message)
  }
}

function send(conn, message) {
  if (conn.readyState === conn.OPEN) {
    conn.send(message, (err) => err && conn.close())
  }
}

/* ------------------------------------------------------------------ *
 *  WebSocket 连接处理（y-websocket 协议）
 * ------------------------------------------------------------------ */

function setupConnection(conn, req) {
  conn.binaryType = 'arraybuffer'
  const docName = decodeURIComponent(req.url.slice(1).split('?')[0]) || 'default'
  const entry = getDoc(docName)
  entry.conns.set(conn, new Set())

  conn.on('message', (data) => {
    const uint8 = new Uint8Array(data)
    const decoder = decoding.createDecoder(uint8)
    const encoder = encoding.createEncoder()
    const messageType = decoding.readVarUint(decoder)
    switch (messageType) {
      case MESSAGE_SYNC:
        encoding.writeVarUint(encoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, encoder, entry.doc, conn)
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder))
        break
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          entry.awareness,
          decoding.readVarUint8Array(decoder),
          conn
        )
        break
    }
  })

  conn.on('close', () => {
    const controlled = entry.conns.get(conn)
    entry.conns.delete(conn)
    if (controlled) {
      awarenessProtocol.removeAwarenessStates(entry.awareness, [...controlled], null)
    }
    if (entry.conns.size === 0) {
      persistDoc(docName)
    }
  })

  // 主动发起 sync step 1
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, entry.doc)
  send(conn, encoding.toUint8Array(encoder))

  // 发送当前 awareness 状态
  const states = entry.awareness.getStates()
  if (states.size > 0) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...states.keys()]))
    send(conn, encoding.toUint8Array(enc))
  }
}

/* ------------------------------------------------------------------ *
 *  修订（快照）时间线
 * ------------------------------------------------------------------ */

function loadRevisions(docName) {
  try {
    return JSON.parse(fs.readFileSync(revFile(docName), 'utf8'))
  } catch {
    return []
  }
}

function saveRevisions(docName, list) {
  fs.writeFileSync(revFile(docName), JSON.stringify(list))
}

function createRevision(docName, label, author) {
  const entry = getDoc(docName)
  const list = loadRevisions(docName)
  const rev = {
    id: crypto.randomBytes(6).toString('hex'),
    label: label || '未命名修订',
    author: author || 'unknown',
    time: new Date().toISOString(),
    update: Buffer.from(Y.encodeStateAsUpdate(entry.doc)).toString('base64')
  }
  list.push(rev)
  while (list.length > MAX_REVISIONS) list.shift()
  saveRevisions(docName, list)
  entry.lastSnapshotAt = Date.now()
  entry.dirty = false
  persistDoc(docName)
  return rev
}

/** 从 delta 中截取 [start, end) 字符区间对应的 insert 操作 */
function sliceDelta(delta, start, end) {
  const ops = []
  let offset = 0
  for (const op of delta) {
    const len = typeof op.insert === 'string' ? op.insert.length : 1
    const opStart = offset
    const opEnd = offset + len
    offset = opEnd
    if (opEnd <= start || opStart >= end) continue
    if (typeof op.insert === 'string') {
      const piece = { insert: op.insert.slice(Math.max(0, start - opStart), Math.min(len, end - opStart)) }
      if (op.attributes) piece.attributes = op.attributes
      ops.push(piece)
    } else {
      ops.push(op) // 嵌入对象整体保留（边界情况）
    }
  }
  return ops
}

/**
 * 恢复历史版本：
 *  - 作为一个普通 Yjs 事务应用到活跃文档（带 origin 标记），
 *    因此它本身就是一次新的 CRDT 变更，会与所有在线/离线客户端正常合并；
 *  - 采用「公共前缀/后缀 diff」，只替换中间差异部分，
 *    使未变化区域上的评论锚点（RelativePosition）尽量保持有效；
 *  - 被替换区域内的评论锚点失效，前端会把对应评论标记为「悬空」；
 *  - 恢复完成后自动生成一条新修订，恢复动作本身进入时间线。
 */
function restoreRevision(docName, revId, author) {
  const entry = getDoc(docName)
  const rev = loadRevisions(docName).find((r) => r.id === revId)
  if (!rev) return null

  const snapDoc = new Y.Doc()
  Y.applyUpdate(snapDoc, new Uint8Array(Buffer.from(rev.update, 'base64')))
  const targetDelta = snapDoc.getText(TEXT_KEY).toDelta()
  const targetStr = snapDoc.getText(TEXT_KEY).toString()

  const ytext = entry.doc.getText(TEXT_KEY)
  entry.doc.transact(() => {
    const cur = ytext.toString()
    let p = 0
    const maxP = Math.min(cur.length, targetStr.length)
    while (p < maxP && cur.charCodeAt(p) === targetStr.charCodeAt(p)) p++
    let s = 0
    const maxS = Math.min(cur.length, targetStr.length) - p
    while (s < maxS && cur.charCodeAt(cur.length - 1 - s) === targetStr.charCodeAt(targetStr.length - 1 - s)) s++
    if (cur.length - p - s > 0) ytext.delete(p, cur.length - p - s)
    const middle = sliceDelta(targetDelta, p, targetStr.length - s)
    if (middle.length > 0) ytext.applyDelta([{ retain: p }, ...middle])
  }, 'restore:' + revId)

  persistDoc(docName)
  return createRevision(docName, `恢复自「${rev.label}」`, author || 'unknown')
}

/* ------------------------------------------------------------------ *
 *  HTTP API
 * ------------------------------------------------------------------ */

const app = express()
app.use(cors())
app.use(express.json())

app.get('/api/health', (req, res) => res.json({ ok: true }))

app.get('/api/docs', (req, res) => {
  const names = new Set()
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.endsWith('.yjs')) names.add(decodeURIComponent(f.slice(0, -4)))
  }
  for (const name of docs.keys()) names.add(name)
  res.json([...names])
})

// 修订时间线（所有客户端看到同一份服务端时间线，保证一致）
app.get('/api/docs/:doc/revisions', (req, res) => {
  const list = loadRevisions(req.params.doc).map(({ update, ...meta }) => meta)
  res.json(list)
})

// 手动创建快照
app.post('/api/docs/:doc/revisions', (req, res) => {
  const { label, author } = req.body || {}
  const rev = createRevision(req.params.doc, label || '手动快照', author)
  const { update, ...meta } = rev
  res.status(201).json(meta)
})

// 预览某个修订的内容
app.get('/api/docs/:doc/revisions/:id', (req, res) => {
  const rev = loadRevisions(req.params.doc).find((r) => r.id === req.params.id)
  if (!rev) return res.status(404).json({ error: 'revision not found' })
  const snapDoc = new Y.Doc()
  Y.applyUpdate(snapDoc, new Uint8Array(Buffer.from(rev.update, 'base64')))
  res.json({
    id: rev.id,
    label: rev.label,
    author: rev.author,
    time: rev.time,
    text: snapDoc.getText(TEXT_KEY).toString()
  })
})

// 恢复某个修订（作为新事务 + 新修订）
app.post('/api/docs/:doc/revisions/:id/restore', (req, res) => {
  try {
    const rev = restoreRevision(req.params.doc, req.params.id, (req.body || {}).author)
    if (!rev) return res.status(404).json({ error: 'revision not found' })
    const { update, ...meta } = rev
    res.json(meta)
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) })
  }
})

/* ------------------------------------------------------------------ *
 *  启动
 * ------------------------------------------------------------------ */

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (conn) => wss.emit('connection', conn, req))
})
wss.on('connection', setupConnection)

// 心跳，清理死连接
const pingInterval = setInterval(() => {
  wss.clients.forEach((conn) => {
    if (conn.isAlive === false) return conn.terminate()
    conn.isAlive = false
    conn.ping()
  })
}, 30000)
wss.on('connection', (conn) => {
  conn.isAlive = true
  conn.on('pong', () => { conn.isAlive = true })
})
wss.on('close', () => clearInterval(pingInterval))

server.listen(PORT, () => {
  console.log(`[collab-doc] server listening on :${PORT}, data dir: ${DATA_DIR}`)
})
