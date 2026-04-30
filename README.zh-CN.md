# MEM-C

面向 AI 智能体的时序知识图谱记忆系统 — 基于 SQLite，零基础设施，混合检索（向量 + 全文 + 图遍历）、MCP Server、文档导入、备份恢复。

**v1.1.0** | [API 文档](./docs/api-reference.md) | [快速上手](./docs/getting-started.md) | [English](./README.md)

## 特性

**核心**
- **时序版本管理** — 实体和边使用 `valid_from` / `valid_until` 标记，追踪事实的变化历程
- **混合检索** — 向量相似度 + FTS5 全文搜索 + 图连通性 + 时间衰减评分
- **分层上下文加载** — L0（实体名册，~200 tokens）/ L1（搜索结果，~800 tokens）/ L2（完整详情，~2000 tokens）
- **实体重要性评分** — 综合指标（时效性 + 度中心性 + 访问频率 + 置信度）
- **图谱整合** — 自动合并重复、衰减过时、清理孤立实体
- **LLM 自动抽取** — 从对话文本中自动提取实体和关系
- **零基础设施** — 纯 `node:sqlite`（Node 22+），无需外部数据库

**性能优化（v0.4+）**
- **sqlite-vec ANN 索引** — 可选近似最近邻搜索，优雅降级到全表扫描
- **增量嵌入** — 内容不变时跳过 `embedFn`（通过 `content_hash` 追踪）
- **批量操作** — `upsertEntities()` / `addEdges()` 单事务批量写入
- **FTS 评分归一化** — 小数据集也能返回有意义的分数
- **搜索缓存** — LRU 缓存（128 条，30s TTL），写入自动失效

**图谱智能（v0.5+）**
- **社区检测** — BFS 连通分量算法，存储到 `communities` / `community_members` 表
- **多跳路径查找** — BFS + 环路发现，任意两实体间路径
- **可视化导出** — Mermaid / DOT / JSON 格式
- **社区摘要** — LLM 为每个社区集群生成标签
- **关系类型推断** — LLM 为泛型关系建议更丰富的类型

**生态系统（v0.6+）**
- **MCP Server** — Model Context Protocol，跨 agent 共享记忆（9 个工具）
- **多用户隔离** — 基于 namespace 的实体/边/事件隔离
- **事件驱动 API** — 类型安全的 `GraphEventEmitter`，7 种生命周期事件
- **REST API** — HTTP 接口，供非 Node.js 环境使用（8 个端点，零依赖）

**模型集成（v1.1+）**
- **内置模型配置** — `mem-c.config.json` 配置 chat/embedding/rerank provider，插件自动使用内置 LLM，无需宿主传入 callback
- **Rerank 管线** — OpenAI 兼容的 rerank API，提升搜索相关性
- **DashScope 原生嵌入** — 支持 DashScope 多模态嵌入 + OpenAI 兼容端点

**文档导入（v1.0+）**
- **统一导入 API** — `importDocument()` 支持 Markdown、PDF、飞书、聊天记录
- **智能分块** — 按语义边界切分（段落 > 句子 > 硬切）
- **导入进度追踪** — `import_sessions` 表，支持断点续传
- **备份与恢复** — 增量备份、时间点恢复

**安全**
- **边去重** — 自动合并重复边并更新权重
- **二进制嵌入存储** — BLOB 存储，节省约 60% 空间
- **FTS 查询安全** — 防止特殊字符导致崩溃
- **多进程安全** — WAL 日志模式 + busy_timeout

## 安装

```bash
npm install mem-c
```

## 架构

```
src/host/
├── graph-schema.ts         # SQLite DDL + FTS5 + vec0 ANN 索引
├── graph-engine.ts         # CRUD + 图遍历 + 时序版本 + 命名空间隔离
├── graph-search.ts         # 混合检索（向量 + FTS + 图 + 时间衰减 + 缓存）
├── graph-context-loader.ts # L0/L1/L2 分层上下文加载
├── graph-consolidator.ts   # 图谱卫生：合并、衰减、清理
├── graph-extractor.ts      # LLM 实体/关系抽取
├── graph-import.ts         # 文档导入管线（Markdown、PDF、飞书、聊天）
├── graph-backup.ts         # 备份与恢复（增量、时间点）
├── graph-llm-client.ts     # 内置 LLM 客户端（chat/embedding/rerank）
├── graph-model-config.ts   # 模型 provider 配置
├── graph-model-adapters.ts # Provider 适配器（OpenAI 兼容、DashScope）
├── graph-migrate.ts        # Markdown 记忆 → 图谱迁移
├── graph-tools.ts          # 智能体工具接口
├── graph-vec.ts            # sqlite-vec ANN 适配器
├── graph-community.ts      # 社区检测 + LLM 摘要
├── graph-inference.ts      # 关系类型推断
├── graph-export.ts         # Mermaid/DOT/JSON 可视化导出
├── graph-events.ts         # 类型安全的生命周期事件
├── graph-mcp.ts            # MCP Server（跨 agent 共享）
└── graph-rest.ts           # REST API（HTTP）
```

## 快速开始

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine, searchGraph } from "mem-c";

// 初始化
const db = new DatabaseSync("memory.db");
const engine = new MemoryGraphEngine(db);
const { entityFtsAvailable } = ensureGraphSchema({ db, engine });

// 存储实体
const user = engine.upsertEntity({ name: "Alice", type: "user", summary: "首席工程师" });
const project = engine.upsertEntity({ name: "GraphDB", type: "project", summary: "图数据库项目" });

// 创建关系（自动去重）
engine.addEdge({ fromId: user.id, toId: project.id, relation: "works_on" });

// 搜索
const results = searchGraph(db, engine, "Alice project");
console.log(results[0]?.entity.name, results[0]?.score);

// 时序：使过时事实失效
engine.invalidateEntity(project.id, "project completed");
const history = engine.getEntityHistory("GraphDB"); // 查看所有版本
```

### 嵌入函数钩子（v0.3+）

```typescript
import { MemoryGraphEngine } from "mem-c";

// 提供嵌入函数
const engine = new MemoryGraphEngine(db, {
  embedFn: (text: string) => {
    // 使用你的嵌入模型（如 OpenAI、本地模型等）
    return generateEmbedding(text);
  }
});

// 存储实体时自动生成嵌入向量
engine.upsertEntity({ name: "React", type: "concept", summary: "UI 库" });
// 嵌入向量从 "React UI 库" 自动生成

// 搜索时自动生成查询嵌入向量
const results = searchGraph(db, engine, "JavaScript 框架");
// 无需手动传入 queryEmbedding
```

### 实体别名（v0.3+）

```typescript
// 大小写不敏感匹配
engine.upsertEntity({ name: "React", type: "concept" });
engine.upsertEntity({ name: "react", type: "concept" }); // 合并到同一实体

// 自定义别名
const entity = engine.upsertEntity({ name: "React", type: "concept" });
engine.addAlias(entity.id, "ReactJS");
engine.addAlias(entity.id, "React.js");

// 通过任意别名查找
const results = engine.findEntities({ name: "reactjs", type: "concept" });
// 返回 "React" 实体
```

## 上下文层级

| 层级 | 用途 | Token 预算 | 使用时机 |
|------|------|-----------|---------|
| **L0** | 系统提示词中的实体名册 | ~200 | 每次请求 |
| **L1** | 搜索触发的摘要 + 关系 | ~800 | 记忆搜索时 |
| **L2** | 完整实体详情 + 历史 + 会话片段 | ~2000 | 按需深入查看 |

```typescript
import { buildL0Context, buildL1Context, buildL2Context, formatL0AsPromptSection } from "mem-c";

const l0 = buildL0Context(engine, { maxTokens: 200 });
const systemPromptSection = formatL0AsPromptSection(l0);

const l1 = buildL1Context(db, engine, "用户查询内容");
const l2 = buildL2Context(engine, entityId);
```

## LLM 抽取

MEM-C 支持两种 LLM 调用模式：

**内置模型（v1.1+）：** 在 `mem-c.config.json` 中配置 chat provider，插件自动使用内置 LLM 执行抽取，无需宿主传入 callback。

**回调注入：** 宿主运行时提供 `llmExtract` 函数。未配置内置模型时使用此方式。

```typescript
import { extractAndMerge } from "mem-c";

// 回调模式 — 宿主提供 LLM 调用
const result = await extractAndMerge({
  engine,
  transcript: "用户讨论了从 REST 迁移到 GraphQL...",
  sessionKey: "session-123",
  llmExtract: async ({ systemPrompt, userPrompt }) => {
    return await callLLM(systemPrompt, userPrompt);
  },
});
// result: { entitiesCreated: 2, edgesCreated: 1, ... }
```

## 智能体工具

本库导出 12 个预构建 tool helper：

| 工具 | 功能 | 用途 |
|------|------|------|
| `memoryGraphSearch` | 混合检索 | 查找相关实体 |
| `memoryStore` | 创建/更新实体 | 存储事实和关系 |
| `memoryBatchStore` | 批量写入 | 单事务写入多个实体 |
| `memoryDetail` | L2 上下文 | 获取完整实体详情 |
| `memoryGraph` | 图可视化 | 展示实体关系 |
| `memoryInvalidate` | 软删除 | 标记事实为过时 |
| `memoryConsolidate` | 图谱卫生 | 合并重复、衰减过时、清理孤立 |
| `memoryDetectCommunities` | 社区检测 | 找出连通实体簇 |
| `memoryFindPaths` | 多跳遍历 | 查找实体之间路径 |
| `memoryExportGraph` | 图导出 | 导出 Mermaid / DOT / JSON |
| `memorySummarizeCommunities` | 回调式摘要 | 用宿主 LLM 为社区生成摘要 |
| `memoryInferRelations` | 回调式推断 | 用宿主 LLM 推断更具体的关系类型 |

OpenClaw 插件注册前 10 个可直接 JSON 调用的工具（到 `memoryExportGraph` 为止）。
后两个 helper（`memorySummarizeCommunities`、`memoryInferRelations`）以库层 API 形式提供。
当 `mem-c.config.json` 配置了 `chat` provider 后，插件会自动使用内置 LLM 客户端执行提取，无需宿主传入 callback。

## 重要性评分

实体通过综合重要性分数排序，实现更智能的 L0 上下文注入：

```typescript
// 重要性 = 0.3 × 时效性 + 0.3 × 连接度 + 0.25 × 访问分 + 0.15 × 置信度
const l0 = buildL0Context(engine, { maxTokens: 200, useImportance: true });
```

访问追踪自动完成 — 搜索命中和详情查看会自动调用 `touchEntity()`。

## 图谱整合

定期清理以维护图谱卫生：

```typescript
import { consolidateGraph } from "mem-c";

// 先预览
const preview = consolidateGraph(engine, { dryRun: true });
console.log(preview); // { merged: 2, decayed: 5, pruned: 3, errors: [] }

// 执行
const result = consolidateGraph(engine);
```

四个阶段在单一事务中执行：
1. **合并** — 同名不同类型的实体 → 保留最高置信度的
2. **衰减** — 降低 30+ 天未访问实体的置信度
3. **清理** — 使低置信度孤立实体失效（无连接，置信度 < 0.3）

## 文档导入（v1.0+）

```typescript
import { importDocument } from "mem-c";

// 导入 Markdown 文件
const result = await importDocument({
  engine,
  source: "/path/to/notes.md",
  parser: markdownParser(),
});
// result: { sessionId, entitiesCreated, edgesCreated, chunksProcessed }
```

支持 Markdown、PDF、飞书文档、聊天记录。进度通过 `import_sessions` 表追踪。

## MCP Server（v0.6+）

通过 Model Context Protocol 暴露记忆工具，支持跨 agent 访问：

```typescript
import { startMcpServer } from "mem-c";

// 在 stdio 上启动 MCP server
await startMcpServer({ dbPath: "./memory.db" });
// 9 个工具可用：memory_search, memory_store, memory_detail 等
```

## 多用户隔离（v0.6+）

按用户隔离数据：

```typescript
import { MemoryGraphEngine } from "mem-c";

const user1 = new MemoryGraphEngine(db, { namespace: "user-123" });
const user2 = new MemoryGraphEngine(db, { namespace: "user-456" });

user1.upsertEntity({ name: "Private", type: "concept" });
user2.findEntities({ name: "Private" }); // → []（隔离）
```

## 事件驱动 API（v0.6+）

订阅图谱变更事件：

```typescript
const engine = new MemoryGraphEngine(db);
engine.getEvents().on("entity:created", (entity) => {
  console.log("新实体:", entity.name);
});
engine.getEvents().on("edge:created", (edge) => {
  console.log("新关系:", edge.relation);
});
```

## REST API（v0.6+）

供非 Node.js 环境使用的 HTTP 接口：

```typescript
import { startRestServer } from "mem-c";

const { port, close } = await startRestServer({ port: 3000 });
// GET  /search?q=...       — 混合搜索
// POST /entities           — 创建实体
// GET  /entities/:name     — 实体详情
// GET  /communities        — 社区检测
// GET  /paths?from=X&to=Y — 路径查找
// GET  /export?format=mermaid — 图导出
// GET  /health             — 服务状态
```

## 环境要求

- Node.js >= 22.0.0（需要内置 `node:sqlite`）

## CI

GitHub Actions 会在每次 PR 和每次推送到 `main` 时，基于 Node 22 与 Node 24 运行 `npm test`、`npm run typecheck` 和 `npm run build`。

## 许可证

MIT
