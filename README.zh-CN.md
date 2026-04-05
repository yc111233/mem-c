# openclaw-memory

面向 AI 智能体的时序知识图谱记忆系统 — 基于 SQLite，零基础设施，支持混合检索（向量 + 全文 + 图遍历）。

[English](./README.md)

## 特性

- **时序版本管理** — 实体和边使用 `valid_from` / `valid_until` 标记，追踪事实的变化历程
- **混合检索** — 向量相似度 + FTS5 全文搜索 + 图连通性 + 时间衰减评分
- **分层上下文加载** — L0（实体名册，~200 tokens）/ L1（搜索结果，~800 tokens）/ L2（完整详情，~2000 tokens）
- **LLM 自动抽取** — 从对话文本中自动提取实体和关系
- **零基础设施** — 纯 `node:sqlite`（Node 22+），无需外部数据库

## 架构

```
src/host/
├── graph-schema.ts         # SQLite DDL + FTS5 虚拟表
├── graph-engine.ts         # CRUD + 图遍历 + 时序版本管理
├── graph-search.ts         # 混合检索（向量 + FTS + 图 + 时间衰减）
├── graph-context-loader.ts # L0/L1/L2 分层上下文加载
├── graph-extractor.ts      # LLM 实体/关系抽取
├── graph-migrate.ts        # Markdown 记忆 → 图谱迁移
└── graph-tools.ts          # 智能体工具接口
```

## 快速开始

```typescript
import { DatabaseSync } from "node:sqlite";
import { ensureGraphSchema, MemoryGraphEngine, searchGraph } from "openclaw-memory";

// 初始化
const db = new DatabaseSync("memory.db");
const { entityFtsAvailable } = ensureGraphSchema({ db });
const engine = new MemoryGraphEngine(db);

// 存储实体
const user = engine.upsertEntity({ name: "Alice", type: "user", summary: "首席工程师" });
const project = engine.upsertEntity({ name: "GraphDB", type: "project", summary: "图数据库项目" });

// 创建关系
engine.addEdge({ fromId: user.id, toId: project.id, relation: "works_on" });

// 搜索
const results = searchGraph(db, engine, "Alice project");
console.log(results[0]?.entity.name, results[0]?.score);

// 时序：使过时事实失效
engine.invalidateEntity(project.id, "project completed");
const history = engine.getEntityHistory("GraphDB"); // 查看所有版本
```

## 上下文层级

| 层级 | 用途 | Token 预算 | 使用时机 |
|------|------|-----------|---------|
| **L0** | 系统提示词中的实体名册 | ~200 | 每次请求 |
| **L1** | 搜索触发的摘要 + 关系 | ~800 | 记忆搜索时 |
| **L2** | 完整实体详情 + 历史 + 会话片段 | ~2000 | 按需深入查看 |

```typescript
import { buildL0Context, buildL1Context, buildL2Context, formatL0AsPromptSection } from "openclaw-memory";

const l0 = buildL0Context(engine, { maxTokens: 200 });
const systemPromptSection = formatL0AsPromptSection(l0);

const l1 = buildL1Context(db, engine, "用户查询内容");
const l2 = buildL2Context(engine, entityId);
```

## LLM 抽取

抽取功能需要传入 `llmExtract` 回调函数 — 宿主运行时必须提供此函数
（openclaw-memory 不内置任何 LLM 客户端）。OpenClaw 插件通过 `agent_end` 事件接收该函数；
独立使用时需自行提供：

```typescript
import { extractAndMerge } from "openclaw-memory";

const result = await extractAndMerge({
  engine,
  transcript: "用户讨论了从 REST 迁移到 GraphQL...",
  sessionKey: "session-123",
  llmExtract: async ({ systemPrompt, userPrompt }) => {
    // 在此调用你的 LLM，返回 JSON 字符串
    return await callLLM(systemPrompt, userPrompt);
  },
});
// result: { entitiesCreated: 2, edgesCreated: 1, ... }
```

## 智能体工具

五个预构建的工具函数，用于智能体集成：

| 工具 | 功能 | 用途 |
|------|------|------|
| `memoryGraphSearch` | 混合检索 | 查找相关实体 |
| `memoryStore` | 创建/更新实体 | 存储事实和关系 |
| `memoryDetail` | L2 上下文 | 获取完整实体详情 |
| `memoryGraph` | 图可视化 | 展示实体关系 |
| `memoryInvalidate` | 软删除 | 标记事实为过时 |

## 从 Markdown 迁移

```typescript
import { migrateMarkdownMemory } from "openclaw-memory";

const result = await migrateMarkdownMemory({
  engine,
  workspaceDir: "/path/to/workspace",
});
// 将 memory/*.md 文件（含 frontmatter）导入图谱
```

## 与 OpenViking 协同

本库与 [OpenViking](https://github.com/nicepkg/openviking) 互补 — 建议配合使用：

| 查询类型 | 最佳工具 |
|---------|---------|
| "找相似的对话" | OpenViking 向量搜索 |
| "Alice 的项目和决策历史？" | 图谱遍历 |
| "这个事实何时发生了变化？" | 时序版本追溯 |

两者均使用 SQLite，可共享同一数据库目录。

## 环境要求

- Node.js >= 22.0.0（需要内置 `node:sqlite`）

## 许可证

MIT
