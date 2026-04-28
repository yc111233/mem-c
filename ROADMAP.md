# Roadmap

> 基于 GitHub Top 10 记忆系统（Mem0、Graphiti/Zep、Letta/MemGPT、Cognee、GraphRAG、LightRAG、A-Mem、MemOS、LangMem）的竞品分析，结合 openclaw-memory 的实际情况制定。

## ✅ Phase 1 (v0.3) — 核心可靠性与数据质量

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| 1.1 | 边去重 | `addEdge` 检测重复 `(from_id, to_id, relation)`，更新权重 | Graphiti (MinHash/LSH) |
| 1.2 | 二进制嵌入存储 | BLOB (Float32Array) 替代 JSON TEXT，节省 ~60% 空间 | 所有竞品均用原生向量索引 |
| 1.3 | FTS 查询安全 | `sanitizeFtsQuery` 过滤 FTS5 操作符 | 行业普遍缺失 |
| 1.4 | 嵌入函数钩子 | `embedFn` 自动生成嵌入向量 | Mem0 (多模型支持) |
| 1.5 | 实体名称归一化 | `entity_aliases` 表 + 大小写不敏感匹配 | Cognee (本体论), Mem0 (LLM) |

## ✅ Phase 2 (v0.4) — 性能与搜索优化

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| 2.1 | sqlite-vec ANN 索引 | 引入 ANN 近似最近邻，替代当前 O(n) 全表扫描 | Mem0 (Qdrant/Pinecone), LightRAG (nano-vectordb) |
| 2.2 | 增量 embedding 更新 | 仅在实体内容变化时重新生成 embedding | Graphiti (content hash) |
| 2.3 | 批量操作 API | `upsertEntities` / `addEdges` 批量接口，减少事务开销 | Mem0 (batch API) |
| 2.4 | FTS 评分归一化 | 修正小文档集下 BM25 分数过低的问题 | — |
| 2.5 | 搜索结果缓存 | 热门查询短期 LRU 缓存 | Letta (in-memory cache) |

## ✅ Phase 3a (v0.5) — 高级图谱能力

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| ✅ 3.1 | 社区检测 | 基于图结构自动发现实体社区/集群 | GraphRAG (Leiden 算法) |
| ✅ 3.2 | 社区摘要 | LLM 为每个社区生成摘要，用于全局搜索 | GraphRAG (community summaries) |
| ✅ 3.3 | 多跳推理 | 支持多跳路径查询（A→B→C 推理链路） | Graphiti (BFS + episodic) |
| ✅ 3.4 | 关系类型推断 | LLM 辅助推断隐含关系 | Cognee (ontology-based) |
| ✅ 3.5 | 图谱可视化导出 | 导出为 Mermaid / DOT / JSON 格式 | — |

## ✅ Phase 4 (v0.6) — 生态与协议

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| ✅ 4.1 | MCP Server | 实现 Model Context Protocol，支持跨 agent 共享记忆 | Mem0 (MCP server) |
| ✅ 4.2 | 多用户隔离 | 按 user_id / namespace 隔离图谱数据 | Mem0 (user/agent/session scopes) |
| ✅ 4.3 | 事件驱动 API | 发布 entity/edge 变更事件，支持外部订阅 | MemOS (event bus) |
| ✅ 4.4 | REST API 层 | 可选的 HTTP 接口，用于非 Node.js 环境 | Mem0 (REST API), Letta (REST) |

## 📋 Phase 5 (v1.0) — 生产就绪

| # | 特性 | 说明 |
|---|------|------|
| ~~5.1~~ | ~~WAL 模式 + 并发优化~~ | ✅ 已在 v0.3.1 实现 (PRAGMA journal_mode=WAL + busy_timeout) |
| 5.2 | 备份与恢复 | 增量备份 + 时间点恢复 |
| 5.3 | 性能基准测试 | 标准化 benchmark suite，CI 中持续追踪 |
| 5.4 | 文档站点 | 完整的 API 文档 + 教程 + 最佳实践 |

---

## 设计原则

1. **零基础设施** — 始终保持纯 SQLite，不引入外部数据库依赖
2. **回调注入** — LLM 和 embedding 通过回调函数注入，库本身不绑定任何 LLM provider
3. **渐进增强** — 每个高级功能都是可选的，基础功能无需额外配置即可使用
4. **与 OpenViking 互补** — 向量搜索交给 OpenViking，本库专注图谱 + 时序 + 结构化检索
