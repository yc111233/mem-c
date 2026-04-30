# Roadmap

> 基于 GitHub Top 10 记忆系统（Mem0、Graphiti/Zep、Letta/MemGPT、Cognee、GraphRAG、LightRAG、A-Mem、MemOS、LangMem）的竞品分析，结合 MEM-C 的实际情况制定。

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

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| ~~5.1~~ | ~~WAL 模式 + 并发优化~~ | ✅ 已在 v0.3.1 实现 (PRAGMA journal_mode=WAL + busy_timeout) | — |
| 5.2 | 备份与恢复 | 增量备份 + 时间点恢复 | — |
| 5.3 | 性能基准测试 | 标准化 benchmark suite，CI 中持续追踪 | — |
| 5.4 | 文档站点 | 完整的 API 文档 + 教程 + 最佳实践 | — |

## 📋 Phase 5b (v1.1) — 知识导入管线

> 目标：从任意文档源导入知识到图谱，实现"读完就记住"。

| # | 特性 | 说明 | 对标竞品 |
|---|------|------|---------|
| 5b.1 | 通用文档导入 API | `importDocument({ source, parser, chunkSize, llmExtract })` 统一入口 | Cognee (多源导入) |
| 5b.2 | Markdown 解析器 | 解析正文内容（非 frontmatter），支持标题层级 → 实体层级映射 | — |
| 5b.3 | PDF 解析器 | 基于 `pdf-parse` 提取文本，支持多页文档分块 | Mem0 (document ingest) |
| 5b.4 | 飞书文档解析器 | 通过飞书 API 拉取文档内容，转换为纯文本 | — |
| 5b.5 | 智能分块器 | 按语义边界（段落/章节）分块，避免截断实体描述 | Cognee (semantic chunking) |
| 5b.6 | 跨 chunk 去重 | 同一实体在不同 chunk 中被提取时自动合并（利用 upsert 幂等性） | — |
| 5b.7 | 导入进度追踪 | `import_sessions` 表记录导入源、状态、已处理块数，支持断点续传 | — |
| 5b.8 | 批量聊天记录导入 | 支持 JSON/文本格式的聊天记录批量提取（循环调用 extractAndMerge） | Mem0 (conversation ingest) |

---

## 设计原则

1. **零基础设施** — 始终保持纯 SQLite，不引入外部数据库依赖
2. **内置模型 + 回调兜底** — `mem-c.config.json` 可配置 chat/embedding/rerank provider，开箱即用；同时保留回调注入接口，宿主可完全接管模型调用
3. **混合检索一体化** — 向量（sqlite-vec ANN）、全文（FTS5）、图遍历、时间衰减在库内统一调度，不依赖外部搜索引擎
4. **渐进增强** — 每个高级功能都是可选的，基础功能无需额外配置即可使用
