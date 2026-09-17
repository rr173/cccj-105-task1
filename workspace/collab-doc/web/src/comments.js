import * as Y from 'yjs'
import { escapeHtml } from './main.js'

/**
 * 评论模块
 *
 * 评论存放在 Y.Array（元素为 Y.Map）中，随文档一起被 CRDT 同步与离线持久化。
 * 锚点使用 Y.RelativePosition（相对位置）：
 *  - 他人的插入/删除只会让锚点平移，评论始终跟随原文字；
 *  - 锚点文字被整体删除后，相对位置解析为 null，评论进入「悬空」状态，
 *    保留原始引用文字，可由用户重新挂接到新选区。
 */
export function initComments({ ydoc, ytext, quill, user }) {
  const ycomments = ydoc.getArray('comments')
  const listEl = document.getElementById('comment-list')
  const danglingEl = document.getElementById('dangling-list')
  const danglingTitle = document.getElementById('dangling-title')
  const addBtn = document.getElementById('btn-add-comment')
  const hintEl = document.getElementById('reattach-hint')

  let pendingReattachId = null
  let rendering = false

  const relPos = (index, assoc) =>
    Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index, assoc))

  function absIndex(rel) {
    try {
      const pos = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(rel),
        ydoc
      )
      return pos && pos.type === ytext ? pos.index : null
    } catch {
      return null
    }
  }

  /** 相对位置引用的字符是否已被删除（yjs 对已删除 item 仍会解析出索引，需检查 tombstone） */
  function anchorDeleted(rel) {
    try {
      const relObj = Y.createRelativePositionFromJSON(rel)
      if (relObj.item == null) return false // 指向类型边界，始终有效
      const structs = ydoc.store.clients.get(relObj.item.client)
      const item = structs && structs.find((s) => s.id.clock === relObj.item.clock)
      return !item || item.deleted
    } catch {
      return true
    }
  }

  /** 解析评论锚点；返回 {start, end}，悬空时返回 null */
  function locate(data) {
    if (anchorDeleted(data.anchorStart) || anchorDeleted(data.anchorEnd)) return null
    const start = absIndex(data.anchorStart)
    const end = absIndex(data.anchorEnd)
    if (start == null || end == null || end <= start) return null
    // 锚定文字被拆分成多段（原本不含换行，现在跨段落）
    const anchored = quill.getText(start, end - start)
    if (anchored.includes('\n') && !(data.quote || '').includes('\n')) return null
    return { start, end }
  }

  /** 悬空原因（用于向用户解释） */
  function danglingReason(data) {
    if (anchorDeleted(data.anchorStart) || anchorDeleted(data.anchorEnd)) return '对应文字已被删除'
    return '对应文字已被拆分'
  }

  /* ---------------- 添加评论 ---------------- */

  quill.on('selection-change', (range) => {
    addBtn.disabled = !(range && range.length > 0)
    // 重新挂接模式：用户选中新文字后完成挂接
    if (pendingReattachId && range && range.length > 0) {
      const id = pendingReattachId
      pendingReattachId = null
      hintEl.hidden = true
      reattach(id, range)
    }
  })

  addBtn.addEventListener('click', () => {
    const range = quill.getSelection()
    if (!range || range.length === 0) return
    const text = window.prompt('评论内容：')
    if (!text) return
    const map = new Y.Map()
    ydoc.transact(() => {
      map.set('id', Date.now().toString(36) + Math.random().toString(36).slice(2, 7))
      map.set('author', user.name)
      map.set('text', text)
      map.set('createdAt', new Date().toISOString())
      map.set('quote', quill.getText(range.index, range.length))
      map.set('resolved', false)
      // 起点 assoc=0：起点处的插入不并入评论；终点 assoc=-1：终点处的插入不并入评论
      map.set('anchorStart', relPos(range.index, 0))
      map.set('anchorEnd', relPos(range.index + range.length, -1))
      ycomments.push([map])
    })
  })

  /* ---------------- 操作 ---------------- */

  function findMap(id) {
    const arr = ycomments.toArray()
    const idx = arr.findIndex((m) => m.get('id') === id)
    return idx >= 0 ? arr[idx] : null
  }

  function reattach(id, range) {
    const map = findMap(id)
    if (!map) return
    ydoc.transact(() => {
      map.set('anchorStart', relPos(range.index, 0))
      map.set('anchorEnd', relPos(range.index + range.length, -1))
      map.set('quote', quill.getText(range.index, range.length))
      map.set('reattachedBy', user.name)
      map.set('reattachedAt', new Date().toISOString())
    })
  }

  function resolveComment(id) {
    const map = findMap(id)
    if (map) ydoc.transact(() => map.set('resolved', true))
  }

  function removeComment(id) {
    const arr = ycomments.toArray()
    const idx = arr.findIndex((m) => m.get('id') === id)
    if (idx >= 0) ydoc.transact(() => ycomments.delete(idx, 1))
  }

  /* ---------------- 渲染 ---------------- */

  function renderHighlights() {
    rendering = true
    try {
      quill.formatText(0, quill.getLength(), 'comment', false, 'silent')
      for (const map of ycomments.toArray()) {
        const data = map.toJSON()
        if (data.resolved) continue
        const loc = locate(data)
        if (loc) quill.formatText(loc.start, loc.end - loc.start, 'comment', data.id, 'silent')
      }
    } finally {
      rendering = false
    }
  }

  function commentCard(data, loc) {
    const card = document.createElement('div')
    card.className = 'comment-card' + (loc ? '' : ' dangling')
    const anchorInfo = loc
      ? `<div class="quote">「${escapeHtml(quill.getText(loc.start, Math.min(loc.end - loc.start, 80)))}」</div>`
      : `<div class="quote missing">原锚定文字：「${escapeHtml(data.quote || '')}」（${danglingReason(data)}）</div>`
    card.innerHTML = `
      <div class="meta"><b>${escapeHtml(data.author)}</b><span>${new Date(data.createdAt).toLocaleString()}</span></div>
      ${anchorInfo}
      <div class="body">${escapeHtml(data.text)}</div>
      ${data.reattachedBy ? `<div class="meta">由 ${escapeHtml(data.reattachedBy)} 重新挂接</div>` : ''}
      <div class="actions"></div>`
    const actions = card.querySelector('.actions')
    if (loc) {
      const locateBtn = button('定位', () => {
        quill.setSelection(loc.start, loc.end - loc.start)
        quill.scrollIntoView()
      })
      actions.appendChild(locateBtn)
    } else {
      const reattachBtn = button('重新挂接', () => {
        pendingReattachId = data.id
        hintEl.hidden = false
        quill.focus()
      })
      actions.appendChild(reattachBtn)
    }
    actions.appendChild(button('解决', () => resolveComment(data.id)))
    actions.appendChild(button('删除', () => removeComment(data.id)))
    return card
  }

  function button(label, onClick) {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', onClick)
    return b
  }

  function renderList() {
    listEl.innerHTML = ''
    danglingEl.innerHTML = ''
    let danglingCount = 0
    let activeCount = 0
    for (const map of ycomments.toArray()) {
      const data = map.toJSON()
      if (data.resolved) continue
      const loc = locate(data)
      if (loc) {
        listEl.appendChild(commentCard(data, loc))
        activeCount++
      } else {
        danglingEl.appendChild(commentCard(data, null))
        danglingCount++
      }
    }
    danglingTitle.hidden = danglingCount === 0
    if (activeCount === 0) listEl.innerHTML = '<div class="empty">暂无评论，选中文字后点击「评论选中文字」。</div>'
  }

  let scheduled = false
  function scheduleRender() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      renderHighlights()
      renderList()
    })
  }

  ycomments.observeDeep(scheduleRender)
  quill.on('text-change', (delta, old, source) => {
    if (!rendering) scheduleRender()
  })

  renderHighlights()
  renderList()
}
