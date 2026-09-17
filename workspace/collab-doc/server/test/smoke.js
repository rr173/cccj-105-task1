'use strict'
/**
 * 端到端冒烟测试：
 *  1. 两个客户端同步编辑
 *  2. 离线编辑后重连合并（不覆盖他人内容）
 *  3. 评论锚点：文字被删除 -> 悬空；恢复版本时未变化区域的锚点保留
 *  4. 修订时间线：快照 / 恢复（恢复本身成为新修订）
 */
process.env.PORT = '8090'
process.env.DATA_DIR = '/tmp/collab-test-data'
process.env.AUTOSNAPSHOT_INTERVAL = '600000'

const fs = require('fs')
fs.rmSync('/tmp/collab-test-data', { recursive: true, force: true })

require('../src/index.js')

const Y = require('yjs')
const WebSocket = require('ws')
global.WebSocket = WebSocket
const { WebsocketProvider } = require('y-websocket')

const WS = 'ws://localhost:8090'
const API = 'http://localhost:8090/api'
const DOC = 'testdoc'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, what, timeout = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fn()) return
    await sleep(50)
  }
  throw new Error('timeout waiting for: ' + what)
}
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg)
  console.log('  ✓', msg)
}

async function main() {
  await sleep(500)

  /* ---------- 1. 双客户端在线同步 ---------- */
  console.log('1. 在线同步')
  const docA = new Y.Doc()
  const providerA = new WebsocketProvider(WS, DOC, docA)
  await waitFor(() => providerA.synced, 'A synced')
  docA.getText('quill').insert(0, 'Hello Brave New World')

  const docB = new Y.Doc()
  const providerB = new WebsocketProvider(WS, DOC, docB)
  await waitFor(() => providerB.synced, 'B synced')
  await waitFor(() => docB.getText('quill').toString().includes('World'), 'B received A text')
  assert(docB.getText('quill').toString() === 'Hello Brave New World', 'B 收到 A 的内容')

  /* ---------- 2. 离线编辑 + 重连合并 ---------- */
  console.log('2. 离线合并')
  providerB.disconnect() // B 断网
  docB.getText('quill').insert(docB.getText('quill').length, ' [B-offline]') // B 离线编辑
  docA.getText('quill').insert(0, '[A-online] ') // A 同时在线编辑
  await sleep(300)
  assert(!docA.getText('quill').toString().includes('B-offline'), '断网期间 A 看不到 B 的编辑')

  providerB.connect() // B 恢复连接
  await waitFor(
    () => docA.getText('quill').toString().includes('B-offline'),
    'A received B offline edits'
  )
  await waitFor(
    () => docB.getText('quill').toString().includes('[A-online]'),
    'B received A edits'
  )
  const merged = docA.getText('quill').toString()
  assert(merged === docB.getText('quill').toString(), '双方收敛到同一文档')
  assert(merged.includes('[A-online]') && merged.includes('[B-offline]'), '双方编辑都保留，晚同步不覆盖已确认内容')

  /* ---------- 3. 评论锚点：删除 -> 悬空 ---------- */
  console.log('3. 评论锚点')
  const textA = docA.getText('quill')
  const full = textA.toString()
  const wStart = full.indexOf('World')
  const anchor = {
    anchorStart: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(textA, wStart, 0)),
    anchorEnd: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(textA, wStart + 5, -1))
  }
  const resolve = (doc, rel) => {
    const pos = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), doc)
    return pos ? pos.index : null
  }
  // 与前端一致的悬空判定：相对位置引用的 item 已被删除
  const anchorDeleted = (doc, rel) => {
    const relObj = Y.createRelativePositionFromJSON(rel)
    if (relObj.item == null) return false
    const structs = doc.store.clients.get(relObj.item.client)
    const item = structs && structs.find((s) => s.id.clock === relObj.item.clock)
    return !item || item.deleted
  }
  assert(resolve(docA, anchor.anchorStart) === wStart, '锚点解析到 World 起点')

  // 他人在锚点前方插入 -> 锚点平移但仍指向 World
  docB.getText('quill').insert(0, '>>> ')
  await waitFor(() => docA.getText('quill').toString().startsWith('>>> '), 'A received prefix insert')
  const shifted = resolve(docA, anchor.anchorStart)
  assert(docA.getText('quill').toString().slice(shifted, shifted + 5) === 'World', '锚点随插入平移，仍指向 World')

  // 删除锚定文字 -> 悬空
  const cur = docA.getText('quill').toString()
  const ws2 = cur.indexOf('World')
  docA.getText('quill').delete(ws2, 5)
  await sleep(200)
  assert(anchorDeleted(docA, anchor.anchorStart) && anchorDeleted(docA, anchor.anchorEnd),
    '锚定文字被删除后锚点失效（评论进入悬空状态）')

  /* ---------- 4. 修订时间线：快照 + 恢复 ---------- */
  console.log('4. 修订时间线')
  const beforeSnap = docA.getText('quill').toString()
  const r1 = await fetch(`${API}/docs/${DOC}/revisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'v1', author: 'tester' })
  }).then((r) => r.json())
  assert(r1.label === 'v1', '创建快照 v1')

  // 在「World」原位置附近重建一个锚点用于验证恢复时的前缀/后缀保留
  const textNow = docA.getText('quill')
  const s = textNow.toString()
  const tailIdx = s.indexOf('[B-offline]')
  const keepAnchor = {
    anchorStart: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(textNow, tailIdx, 0)),
    anchorEnd: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(textNow, tailIdx + 5, -1))
  }

  // 快照后继续编辑（删除开头一段）
  docA.getText('quill').delete(0, 8)
  await sleep(200)
  assert(docA.getText('quill').toString() !== beforeSnap, '快照后文档被修改')

  // 恢复 v1
  const r2 = await fetch(`${API}/docs/${DOC}/revisions/${r1.id}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ author: 'tester' })
  }).then((r) => r.json())
  assert(r2.label.includes('v1'), '恢复动作生成新修订：' + r2.label)

  await waitFor(() => docA.getText('quill').toString() === beforeSnap, 'A converged to restored text')
  assert(docA.getText('quill').toString() === beforeSnap, '恢复后内容等于 v1 快照')

  // 恢复采用前缀/后缀 diff：未变化区域上的锚点仍然有效
  const kStart = resolve(docA, keepAnchor.anchorStart)
  assert(kStart !== null && docA.getText('quill').toString().slice(kStart, kStart + 5) === '[B-of',
    '恢复后未变化区域的评论锚点仍然有效')

  // 时间线一致性
  const list = await fetch(`${API}/docs/${DOC}/revisions`).then((r) => r.json())
  assert(list.length === 2 && list[1].id === r2.id, '时间线包含 v1 与恢复产生的新修订')
  const detail = await fetch(`${API}/docs/${DOC}/revisions/${r1.id}`).then((r) => r.json())
  assert(detail.text === beforeSnap, '可预览 v1 内容')

  /* ---------- 5. 持久化 ---------- */
  assert(fs.existsSync('/tmp/collab-test-data/' + DOC + '.yjs'), '文档已持久化到磁盘')
  assert(fs.existsSync('/tmp/collab-test-data/' + DOC + '.revisions.json'), '修订已持久化到磁盘')

  providerA.destroy()
  providerB.destroy()
  console.log('\n全部测试通过 ✅')
  process.exit(0)
}

main().catch((e) => {
  console.error('测试失败:', e)
  process.exit(1)
})
