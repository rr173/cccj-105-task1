import Quill from 'quill'
import QuillCursors from 'quill-cursors'
import * as Y from 'yjs'
import { QuillBinding } from 'y-quill'
import { WebsocketProvider } from 'y-websocket'
import { IndexeddbPersistence } from 'y-indexeddb'
import 'quill/dist/quill.snow.css'
import './styles.css'
import { initComments } from './comments.js'
import { initRevisions } from './revisions.js'

const API_URL = import.meta.env.VITE_API_URL || `${location.protocol}//${location.hostname}:8080`
const WS_URL = import.meta.env.VITE_WS_URL || API_URL.replace(/^http/, 'ws')
const docName = new URLSearchParams(location.search).get('doc') || 'demo'

/* 用户身份（本地生成并记住） */
function getIdentity() {
  let id = JSON.parse(localStorage.getItem('collab-identity') || 'null')
  if (!id) {
    const colors = ['#e0533d', '#2f9e44', '#1971c2', '#9c36b5', '#f08c00', '#0c8599']
    id = {
      name: '用户-' + Math.random().toString(36).slice(2, 6),
      color: colors[Math.floor(Math.random() * colors.length)]
    }
    localStorage.setItem('collab-identity', JSON.stringify(id))
  }
  return id
}
const user = getIdentity()

/* 自定义 Quill 格式：评论高亮（class 型 attributor，不影响文字本身格式） */
const Parchment = Quill.import('parchment')
const CommentClass = new Parchment.ClassAttributor('comment', 'ql-comment', {
  scope: Parchment.Scope.INLINE
})
Quill.register(CommentClass, true)
Quill.register('modules/cursors', QuillCursors)

const quill = new Quill('#editor', {
  theme: 'snow',
  modules: {
    cursors: true,
    toolbar: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ color: [] }, { background: [] }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      ['blockquote', 'code-block'],
      ['clean']
    ]
  },
  placeholder: '开始协作编辑…（断网也可以继续输入）'
})

/* CRDT 文档 + 离线持久化 + 网络同步 */
const ydoc = new Y.Doc()
const ytext = ydoc.getText('quill')

// 离线编辑：变更先写入 IndexedDB，断网期间不丢失
const idb = new IndexeddbPersistence('collab-doc-' + docName, ydoc)

const provider = new WebsocketProvider(WS_URL, docName, ydoc)
provider.awareness.setLocalStateField('user', { name: user.name, color: user.color })

new QuillBinding(ytext, quill, provider.awareness)

/* 连接状态与在线成员 */
const statusEl = document.getElementById('conn-status')
const bannerEl = document.getElementById('offline-banner')
provider.on('status', ({ status }) => {
  const online = status === 'connected'
  statusEl.textContent = online ? '已连接' : '离线'
  statusEl.className = 'status ' + (online ? 'online' : 'offline')
  bannerEl.hidden = online
})

const peersEl = document.getElementById('peers')
provider.awareness.on('change', () => {
  const peers = []
  provider.awareness.getStates().forEach((state, clientId) => {
    if (clientId !== ydoc.clientID && state.user) peers.push(state.user)
  })
  peersEl.innerHTML = peers
    .map((p) => `<span class="peer" style="border-color:${p.color};color:${p.color}">${escapeHtml(p.name)}</span>`)
    .join('')
})

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

document.getElementById('doc-name').textContent = '文档：' + docName

initComments({ ydoc, ytext, quill, user })
initRevisions({ docName, apiUrl: API_URL, user })

export { ydoc, ytext, quill, provider, user, escapeHtml }
