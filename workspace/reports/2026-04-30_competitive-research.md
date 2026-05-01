# AI Agent 记忆系统设计对比调研报告

> 调研时间：2026-04-30
> 调研方法：GitHub API + 项目文档 + 源码分析
> 覆盖项目：10 个（含 MEM-C 自身）
> 目标：为 openclaw-memory (MEM-C) 项目提供竞品洞察和优化方向

---

## 一、项目概览表格

| 项目 | GitHub Stars | 核心定位 | 存储方案 | 检索方式 | 特色 |
|------|-------------|----------|----------|----------|------|
| **mem0** | ~24k | 通用 AI 记忆层 | Qdrant/Pinecone/Chroma (向量) + Neo4j (图) | 向量相似度 + 图遍历 | 自动记忆提取、多用户隔离、MCP Server |
| **Letta (MemGPT)** | ~14k | 有状态 Agent 框架 | PostgreSQL + pgvector | 向量搜索 + 工作记忆窗口 | 分层记忆 (core/archival/recall)、虚拟上下文管理 |
| **Zep** | ~2.5k | 长期记忆服务 | PostgreSQL + pgvector | 向量 + 时间衰减 + 知识图谱 | Graphiti 知识图谱、事实追踪、事实失效检测 |
| **langmem** | ~800 | LangChain 记忆模块 | LangGraph Store (可插拔) | 向量搜索 | 与 LangChain 生态深度集成、三种记忆类型 |
| **GraphRAG** | ~22k | 图增强检索 | Neo4j/NetworkX (图) + 向量 | 社区检测 + 图遍历 + 全局摘要 | Leiden 社区检测、层级摘要、全局/局部搜索 |
| **knowledge-graph-memory** | ~3k | Claude 知识图谱记忆 | JSON 文件 (本地) | 图遍历 + BFS | Anthropic 官方 MCP Server、实体-关系图 |
| **claude-mem** | ~500 | Claude Code 记忆插件 | SQLite + Markdown | FTS + 时间排序 | 与 Claude Code 深度集成、自动记忆提取 |
| **Supermemory** | ~8k | 第二大脑 | Supabase (PostgreSQL + pgvector) | 向量 + 全文搜索 | Chrome 扩展、自动高亮保存、语义搜索 |
| **Cognee** | ~2k | 知识图谱引擎 | Neo4j + Qdrant | 图遍历 + 向量 + 本体论 | 多源导入、本体论推理、增量更新 |
| **OpenViking (memory-viking)** | 内部 | OpenClaw 长期记忆 | FastAPI 后端 (向量存储) | 向量语义搜索 + tag 过滤 | URI 寻址、tag 编码、自动 capture/recall、本地 Python 服务 |
| **claude-mem** | ~500 | Claude Code 记忆插件 | SQLite (better-sqlite3) + Markdown | FTS + tree-sitter 代码解析 + 时间排序 | Hook 全生命周期、代码感知记忆、localhost worker、MCP Server |
| **MEM-C** | 新项目 | Agent 时序知识图谱 | SQLite (零基础设施) | 向量 + FTS + 图遍历 + 时间衰减 | 时序版本控制、L0/L1/L2 分层上下文、纯 SQLite |

---

## 二、关键设计模式分析

### 模式 1: 分层记忆架构 (Tiered Memory)

**定义**: 将记忆分为多个层次，每层有不同的容量、持久性和访问模式。

**代表项目与实现**:

| 项目 | 层次设计 | 容量 | 持久性 |
|------|---------|------|--------|
| **Letta/MemGPT** | Core Memory (系统提示) + Archival Memory (向量) + Recall Memory (对话历史) | Core: ~2k tokens, Archival: 无限, Recall: 无限 | Core: 常驻, Archival/Recall: 按需 |
| **MEM-C** | L0 (实体清单, ~200t) + L1 (搜索结果, ~800t) + L2 (完整详情, ~2000t) | L0: 50实体, L1: 6结果, L2: 1实体 | L0: 每次请求, L1: 搜索触发, L2: 按需 |
| **Zep** | Working Memory + Long-term Memory + Episodic Memory | 动态分配 | 自动管理 |

### 模式 2: 混合检索策略 (Hybrid Retrieval)

| 项目 | 向量 | 全文 | 图遍历 | 时间衰减 | 融合方式 |
|------|------|------|--------|---------|---------|
| **MEM-C** | sqlite-vec ANN | FTS5 BM25 | BFS 多跳 | 指数衰减 (半衰期 30 天) | 加权求和 (0.5v + 0.3f + 0.2g) × temporal × confidence |
| **mem0** | Qdrant/Pinecone | 无 | Neo4j | 无 | 纯向量 + 图遍历 |
| **Zep** | pgvector | PostgreSQL FTS | Graphiti | 时间加权 | 多信号融合 |
| **GraphRAG** | 向量索引 | 无 | Leiden 社区 | 无 | 社区摘要 + 图遍历 |

### 模式 3: 自动记忆提取 (Automatic Memory Extraction)

| 项目 | 提取来源 | 提取方式 | 输出格式 |
|------|---------|---------|---------|
| **mem0** | 对话历史 | LLM 提取 + 去重 | 事实列表 (fact triples) |
| **Letta** | 对话 + 函数调用 | LLM 提取 | 核心记忆键值对 |
| **Zep** | 对话历史 | LLM + NER | 知识图谱三元组 |
| **MEM-C** | 对话转录 | LLM 提取 + upsert | 实体-关系图 |

### 模式 4: 图谱整固与遗忘 (Graph Consolidation & Forgetting)

| 项目 | 合并策略 | 衰减机制 | 修剪策略 |
|------|---------|---------|---------|
| **MEM-C** | 同名实体合并 (保留最高置信度) | 30 天未访问 → confidence × 0.9 | 低置信度 (<0.3) + 无边 → 失效 |
| **Zep** | 事实冲突检测 | 时间衰减 | 自动失效旧事实 |
| **mem0** | LLM 判断是否重复 | 无显式衰减 | 手动删除 |

### 模式 5: 跨 Agent 共享记忆 (Cross-Agent Memory Sharing)

| 项目 | 共享方式 | 隔离粒度 | 协议 |
|------|---------|---------|------|
| **MEM-C** | MCP Server (9 tools) + REST API | namespace (user_id) | MCP + HTTP |
| **mem0** | MCP Server + REST API | user/agent/session | MCP + HTTP |
| **knowledge-graph-memory** | MCP Server | 文件隔离 | MCP |

---

## 三、技术选型趋势

### Embedding 模型
- OpenAI text-embedding-3-small 仍是主流（mem0, Zep, MEM-C）
- 趋势：向本地/开源 embedding 模型转移（all-MiniLM, nomic-embed-text）

### 向量数据库
- pgvector 崛起（Zep, Letta 复用 PostgreSQL）
- 嵌入式方案满足"零基础设施"需求（sqlite-vec, LanceDB）
- MEM-C 的 sqlite-vec 选型符合趋势

### 图数据库
- 图数据库不是必须的 — 邻接表 + 递归 CTE 在中小规模下足够
- 知识图谱从"纯向量"到"向量 + 图谱"是明确趋势
- 社区检测中 Leiden 算法被广泛采用

### 记忆格式
- 向实体-关系图谱方向收敛（支持多跳推理、关系查询、图谱整固）

---

## 四、竞争象限分析

```
                    高功能丰富度
                         |
    mem0 ●               |         ● Cognee
    (向量+图, Qdrant+Neo4j)|        (图谱+本体论, Neo4j+Qdrant)
                         |
    Zep ●                |
    (事实图谱, PostgreSQL)|
                         |
    Letta ●              |         ● GraphRAG
    (分层记忆, PostgreSQL)|         (社区检测, Neo4j)
                         |
低基础设施 ─────────────────────────────── 高基础设施
                         |
    MEM-C ●              |
    (时序图谱, SQLite)    |
                         |
    knowledge-graph-memory ●
    (JSON 文件)           |
                         |
                    低功能丰富度
```

**MEM-C 的独特位置**: 在"零基础设施"象限中功能最丰富。

---

## 五、对 MEM-C 的 8 条优化建议

| # | 建议 | 优先级 | 实现难度 | 对标 |
|---|------|--------|---------|------|
| 1 | 增强事实冲突检测 | HIGH | MEDIUM | Zep 事实失效 |
| 2 | 层级社区检测 (Leiden) | MEDIUM | MEDIUM | GraphRAG |
| 3 | 完善 Rerank 集成 | HIGH | LOW | mem0/Zep |
| 4 | 记忆审计日志 | MEDIUM | LOW | 企业需求 |
| 5 | 标准化导入/导出 (JSON-LD) | MEDIUM | LOW-MEDIUM | 互操作性 |
| 6 | 优化大规模向量搜索 | HIGH | MEDIUM | 性能 |
| 7 | Agent 主动记忆管理 | LOW | MEDIUM | Letta |
| 8 | 多模态记忆支持 | LOW | HIGH | 扩展性 |

---

---

## 六、补充竞品详细分析

### OpenViking (memory-viking)

**定位**：OpenClaw 生态的长期记忆引擎，基于 FastAPI Python 后端 + TypeScript 客户端。

**架构特点**：
- **URI 寻址**：`viking://user/memories`、`viking://agent/memories`，支持 user/agent 双作用域
- **Tag 编码系统**：每条记忆带 sentiment/entities/category/source 标签，支持 tag 过滤的语义搜索
- **Session 模型**：记忆通过 session 提交（add message → commit → 自动提取），支持同步/异步两种模式
- **生命周期 Hook**：
  - `before_agent_start` → 自动 recall 相关记忆注入上下文
  - `agent_end` → 自动 capture 对话中的有价值信息
- **本地/远程双模式**：local 模式自动启动 Python FastAPI 服务，remote 模式连接已有服务

**MEM-C 可借鉴**：
1. **Tag 编码** — MEM-C 的 entity 只有 type，缺少 tag 维度。增加 category/source/sentiment 标签可以增强过滤能力
2. **Session-based 提取** — OpenViking 的 "先写 session 再 commit" 模式比 MEM-C 的 "直接 extractAndMerge" 更灵活，支持延迟提取和批量提交
3. **Auto-recall hook** — MEM-C 的 L0 注入是被动的，OpenViking 的 before_agent_start hook 是主动的

**MEM-C 优势**：
- 知识图谱（实体-关系）vs OpenViking 的扁平记忆
- 图遍历、路径查找、社区检测 — OpenViking 没有
- 零基础设施 vs 需要 Python FastAPI 服务

---

### claude-mem

**定位**：Claude Code 的持久化记忆插件，通过 Hook 系统实现全生命周期记忆管理。

**架构特点**：
- **localhost Worker**：`localhost:37777` 常驻 Node.js/Bun 服务，SQLite 存储
- **Hook 全生命周期**：
  - `SessionStart` → 注入上下文（最近活动、相关记忆）
  - `UserPromptSubmit` → session 初始化
  - `PostToolUse` → 每次工具调用后提取 observation
  - `PreToolUse (Read)` → 文件上下文注入
  - `Stop` → 会话摘要生成
  - `SessionEnd` → 会话完成处理
- **Tree-sitter 代码感知**：支持 16+ 编程语言的 AST 解析，代码搜索不只是文本匹配
- **MCP Server**：暴露 `search`、`timeline`、`build_corpus`、`query_corpus` 等工具
- **知识 Corpus**：可以从观察记录构建可查询的知识库

**MEM-C 可借鉴**：
1. **PostToolUse observation** — claude-mem 在每次工具调用后提取 observation，MEM-C 只在会话结束时提取。增量提取能捕获更多细节
2. **代码感知** — tree-sitter 集成让记忆搜索能理解代码结构，不只是文本匹配
3. **知识 Corpus** — 从记忆中构建可查询的知识库，支持 priming + Q&A

**MEM-C 优势**：
- 知识图谱 vs 扁平 observation 列表
- 图遍历、路径查找、社区检测
- 重要度评分、时间衰减、consolidation

---

### 三者对比矩阵

| 特性 | MEM-C | OpenViking | claude-mem |
|------|-------|------------|------------|
| 存储 | SQLite (零依赖) | FastAPI 后端 | SQLite (localhost) |
| 数据模型 | 实体-关系图 | 扁平记忆 + tags | observation 列表 |
| 检索 | 向量+FTS+图遍历 | 向量+tag 过滤 | FTS+tree-sitter |
| 知识图谱 | ✅ 核心特性 | ❌ | ❌ |
| 代码感知 | ❌ | ❌ | ✅ tree-sitter |
| 自动提取 | 会话结束 | session commit | 每次工具调用 |
| 自动注入 | L0/L1/L2 | before_agent_start | SessionStart |
| 生命周期 | MCP 工具 | Hook + MCP | 全生命周期 Hook |
| 社区检测 | ✅ BFS | ❌ | ❌ |
| 时间衰减 | ✅ | ❌ | ❌ |
| Tag 过滤 | ❌ | ✅ | ❌ |
| 多用户隔离 | namespace | user/agent scope | ❌ |

---

> 报告生成：2026-04-30
> 调研范围：12 个 AI Agent 记忆系统项目
> 核心结论：MEM-C 在"零基础设施"象限中功能最丰富，时序版本控制是独特优势。建议优先增强事实冲突检测、tag 编码系统和生命周期 hook。
