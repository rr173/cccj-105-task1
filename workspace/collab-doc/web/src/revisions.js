import { escapeHtml } from './main.js'

/**
 * 修订时间线模块
 *
 * 时间线由服务端统一维护（所有客户端看到一致的列表）。
 * 「恢复」调用服务端接口：服务端把历史版本作为一个新的 CRDT 事务应用到文档，
 * 并自动生成一条新修订 —— 恢复动作本身也参与后续合并。
 */
export function initRevisions({ docName, apiUrl, user }) {
  const modal = document.getElementById('history-modal')
  const listEl = document.getElementById('revision-list')
  const previewModal = document.getElementById('preview-modal')
  const previewTitle = document.getElementById('preview-title')
  const previewContent = document.getElementById('preview-content')

  const api = (path, options) =>
    fetch(`${apiUrl}/api/docs/${encodeURIComponent(docName)}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    }).then((r) => {
      if (!r.ok) return r.json().then((e) => Promise.reject(new Error(e.error || r.statusText)))
      return r.json()
    })

  async function loadList() {
    const revisions = await api('/revisions')
    listEl.innerHTML = ''
    if (revisions.length === 0) {
      listEl.innerHTML = '<div class="empty">还没有修订快照。点击「新建快照」创建第一个版本。</div>'
      return
    }
    for (const rev of [...revisions].reverse()) {
      const item = document.createElement('div')
      item.className = 'revision-item'
      item.innerHTML = `
        <div class="rev-main">
          <div class="rev-label">${escapeHtml(rev.label)}</div>
          <div class="rev-meta">${escapeHtml(rev.author)} · ${new Date(rev.time).toLocaleString()}</div>
        </div>
        <div class="rev-actions"></div>`
      const actions = item.querySelector('.rev-actions')

      const previewBtn = document.createElement('button')
      previewBtn.textContent = '预览'
      previewBtn.addEventListener('click', async () => {
        const detail = await api(`/revisions/${rev.id}`)
        previewTitle.textContent = `预览：${detail.label}（${new Date(detail.time).toLocaleString()}）`
        previewContent.textContent = detail.text || '（空文档）'
        previewModal.hidden = false
      })

      const restoreBtn = document.createElement('button')
      restoreBtn.textContent = '恢复此版本'
      restoreBtn.className = 'danger'
      restoreBtn.addEventListener('click', async () => {
        if (!window.confirm(`确定恢复到「${rev.label}」？\n恢复会作为新修订记录在时间线中，并与他人的编辑自动合并。`)) return
        await api(`/revisions/${rev.id}/restore`, {
          method: 'POST',
          body: JSON.stringify({ author: user.name })
        })
        await loadList()
      })

      actions.appendChild(previewBtn)
      actions.appendChild(restoreBtn)
      listEl.appendChild(item)
    }
  }

  document.getElementById('btn-history').addEventListener('click', () => {
    modal.hidden = false
    loadList().catch((e) => alert('加载时间线失败：' + e.message))
  })
  document.getElementById('btn-close-history').addEventListener('click', () => (modal.hidden = true))
  document.getElementById('btn-close-preview').addEventListener('click', () => (previewModal.hidden = true))

  document.getElementById('btn-new-snapshot').addEventListener('click', async () => {
    const label = window.prompt('快照说明：', '手动快照')
    if (label == null) return
    await api('/revisions', { method: 'POST', body: JSON.stringify({ label, author: user.name }) })
    await loadList()
  })
}
