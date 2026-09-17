# 多人协作文档

基于 **Yjs (CRDT)** 的多人协作文档应用，支持离线编辑、锚定评论、悬空评论重挂接、修订时间线与版本恢复。

## 快速开始

### Docker（推荐）

```bash
docker compose up --build
```

- 前端：http://localhost:8081 （可用 `?doc=<名字>` 切换文档）
- 服务端：http://localhost:8080 （WebSocket 同步 + REST API，数据持久化在 `server-data` 卷）

### 本地开发

```bash
cd server && npm install && npm start        # :8080
cd web && npm install && npm run dev         # :5173（/api 代理到 8080）
```

### 运行冒烟测试

```bash
cd server && npm install && node test/smoke.js
```

覆盖：双客户端同步、离线编辑重连合并、评论锚点平移/悬空、快照/恢复/恢复生成新修订、磁盘持久化。

## 需求与实现对应

| 需求 | 实现 |
| --- | --- |
| 断网可编辑 | `y-indexeddb` 把每次变更写入浏览器 IndexedDB；断网期间编辑不丢失，页面有离线提示条 |
| 恢复连接自动合并 | Yjs CRDT：重连后走 sync 协议交换缺失更新，插入/删除/格式（Quill Delta 属性）按 CRDT 规则合并 |
| 晚同步不覆盖他人内容 | CRDT 交换的是增量 update 而非整文档快照，合并是交换律/结合律/幂等的——任何客户端何时同步都不会覆盖别人已确认的内容（冒烟测试第 2 节验证） |
| 锚定到文字范围的评论 | 评论存于 `Y.Array`，锚点是 `Y.RelativePosition`（起点 assoc=0、终点 assoc=-1），他人编辑只让锚点平移，评论始终跟随原文字 |
| 文字被删除/拆分 → 悬空 | 检测锚点引用的 item tombstone（已删除）或锚定范围被换行拆分 → 评论进入「悬空」区，保留原引用文字与原因说明，可选中新文字「重新挂接」 |
| 一致的修订时间线 | 时间线由服务端统一维护（手动快照 + 每分钟自动快照），所有客户端读取同一份列表 |
| 恢复历史版本 | 服务端把目标版本以「公共前缀/后缀 diff」作为一个 **Yjs 事务** 应用到活跃文档：它本身就是一次新的 CRDT 变更，与所有在线/离线客户端正常合并；未变化区域上的评论锚点保持有效；恢复后自动生成「恢复自「X」」新修订进入时间线 |

## 架构

```
web/      Quill 编辑器 + y-quill 绑定 + y-websocket provider + y-indexeddb 离线持久化
server/   Node.js：y-websocket 兼容同步协议（y-protocols + ws）、文件持久化、
          修订快照 REST API（GET/POST /api/docs/:doc/revisions，POST .../:id/restore）
```

关键设计：

- **同步协议**：服务端自行实现 y-websocket 消息协议（sync step1/2 + update 广播 + awareness），依赖全为纯 JS，容器构建无需原生编译。
- **持久化**：文档状态以 Yjs update 编码写入 `data/<doc>.yjs`（防抖 2s + 全部断连时落盘）；修订写入 `data/<doc>.revisions.json`。
- **恢复即合并**：恢复不是「替换文档」，而是对活跃 doc 执行 `delete(差异中段) + applyDelta(新中段)` 的普通事务，因此天然参与后续 CRDT 合并，且尽量保留未变化区域的评论锚点。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/docs` | 文档列表 |
| GET | `/api/docs/:doc/revisions` | 修订时间线 |
| POST | `/api/docs/:doc/revisions` | 新建快照 `{label, author}` |
| GET | `/api/docs/:doc/revisions/:id` | 预览某修订内容 |
| POST | `/api/docs/:doc/revisions/:id/restore` | 恢复该版本（生成新修订） |
| WS | `/:doc` | Yjs 同步 + 光标 awareness |
