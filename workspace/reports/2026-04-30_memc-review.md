# MEM-C 深度 Review 报告

> 审查人：Opus 4.7（via MiMo 代理）+ 竞品调研
> 日期：2026-04-30
> 项目：mem-c v1.0.0
> 代码量：~3500 行 TypeScript（12 个核心模块）

---

## 一、总体评价

MEM-C 是一个设计精良的单机 agent 记忆系统。**零外部依赖**（SQLite + sqlite-vec）的选型极其务实，L0/L1/L2 三层上下文注入是独特的设计亮点，时间有效性（valid_from/valid_until）的实体版本化方案在同类项目中少见。代码质量高，事务管理严谨，降级策略完备。

主要短板：社区检测过于简单（BFS 连通分量）、缺乏语义去重、记忆自省能力弱。

---

## 二、评分

| 维度 | 分数 | 说明 |
|------|------|------|
| 存储架构 | 9/10 | SQLite WAL + sqlite-vec + FTS5 组合堪称单机最优解 |
| 检索质量 | 7/10 | 混合检索融合合理，但权重固定、缺少 query-adaptive 调整 |
| 知识提取 | 7/10 | extraction prompt 精心设计，但纯 name+type 去重有盲区 |
| 图维护 | 6/10 | 合并/衰减/修剪三阶段完整，但社区检测和语义去重需加强 |
| 上下文注入 | 9/10 | L0/L1/L2 分层 + token budget 自适应是行业领先设计 |
| API/集成 | 8/10 | MCP 9 个工具覆盖核心场景，缺批量搜索和 memory stats |
| 性能 | 8/10 | 缓存、增量 embed、batch 事务都有，full scan 5000 限制需关注 |
| 安全性 | 7/10 | FTS 注入防护到位，namespace 隔离基本完备 |
| **综合** | **7.9/10** | |

---

## 三、优化建议

### P0 — 必须修复

#### 1. 语义去重：name+type 匹配不够

**问题**：`upsertEntity` 只按 `(name, type)` 做精确匹配 + normalized alias。同义实体（如"React"和"React.js"、"小米推送"和"MiPush"）会创建重复节点。

**对标**：mem0 使用 embedding 相似度做实体消解（entity resolution），Zep 有专门的 entity resolution pipeline。

**建议**：
```typescript
// 在 upsertEntity 中，exact match 失败后增加语义匹配
if (!existing && embedding) {
  // 找 embedding 最相似的同类型实体
  const similar = vecKnn(db, embedding, 5, true);
  for (const hit of similar) {
    if (hit.distance < 0.15) { // 高相似度阈值
      const candidate = this.getEntity(hit.id);
      if (candidate?.type === input.type) {
        existing = candidate;
        break;
      }
    }
  }
}
```

**优先级**：P0 — 数据质量的基础问题，随实体增长会指数级恶化。

#### 2. 合并时边冲突处理

**问题**：`reassignEdges` 在合并两个实体时，如果 A→C 和 B→C 存在相同 relation 的边，会产生重复边。虽然 `addEdge` 有 dedup，但 `reassignEdges` 直接 UPDATE SQL 绕过了 dedup 逻辑。

**建议**：合并后执行一次边去重扫描：
```sql
DELETE FROM edges WHERE id NOT IN (
  SELECT MIN(id) FROM edges WHERE valid_until IS NULL
  GROUP BY from_id, to_id, relation
) AND valid_until IS NULL;
```

---

### P1 — 强烈建议

#### 3. 社区检测升级：BFS → Leiden/Louvain

**问题**：当前 BFS 连通分量只能找到"是否连通"，无法识别图中的**层次化社区结构**。一个包含 100 个实体的大连通分量会被当作一个社区，失去结构信息。

**对标**：Microsoft GraphRAG 使用 Leiden 算法做层次化社区检测，每个层级生成摘要，支持 global/local search。

**建议**：实现 Leiden 算法（~200 行），或引入 `graphology-communities-louvain`：
- 支持分辨率参数控制社区粒度
- 为每个社区层级生成摘要（已有 `summarizeCommunities` 框架）
- L0 context 可注入社区标签而非扁平实体列表

**收益**：让 agent 能在更高抽象层级理解记忆结构（"这个用户的记忆主要围绕 MiPush 项目和 AI 工具"）。

#### 4. 搜索权重自适应

**问题**：搜索权重固定为 `vector:0.5, fts:0.3, graph:0.2`。但不同查询场景需要不同权重：
- 精确名称查询（"MiPush"）→ FTS 应主导
- 语义模糊查询（"推送服务的性能优化方案"）→ vector 应主导
- 关系查询（"谁负责后端"）→ graph 应主导

**建议**：
```typescript
// 根据查询特征动态调整权重
function adaptiveWeights(query: string, queryEmbedding?: number[]) {
  const isExactName = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+)*$/.test(query);
  const hasRelationWords = /谁|什么关系|负责|属于/.test(query);

  if (isExactName) return { vector: 0.2, fts: 0.6, graph: 0.2 };
  if (hasRelationWords) return { vector: 0.3, fts: 0.2, graph: 0.5 };
  return { vector: 0.5, fts: 0.3, graph: 0.2 }; // 默认
}
```

#### 5. Episode 索引优化

**问题**：`findEpisodesForEntity` 使用 `json_each` 做 JSON 数组搜索，没有 GIN 索引。当 episode 数量增长到 10k+，这个查询会很慢。

**建议**：
- 方案 A：创建 episode_entity_bridge 关联表（episode_id, entity_id），B-tree 索引
- 方案 B：SQLite 3.45+ 支持 JSON 索引，创建 generated column + index

#### 6. 记忆自省能力

**问题**：缺少"agent 自己管理记忆"的能力。Letta/MemGPT 的核心理念是 agent 能自主决定何时存储、修改、遗忘记忆。

**对标**：Letta 让 agent 通过 function call 自己编辑记忆（`core_memory_replace`、`archival_memory_insert`）。当前 MEM-C 的提取是被动的（会话结束时 LLM 提取），agent 无法主动干预。

**建议**：增加 `memory_reflect` 工具：
```typescript
// Agent 主动反思和整理记忆
memory_reflect({
  action: "consolidate", // merge | decay | summarize
  entities: ["MiPush", "推送服务"],
  insight: "MiPush 和推送服务是同一个项目，应该合并"
})
```

#### 7. 配置热更新

**问题**：`loadConfig` 在启动时读取一次，运行时修改配置文件不会生效。对于长期运行的 MCP server 这是个问题。

**建议**：使用 `fs.watch` 监听配置文件变化，或提供 `memory_reload_config` 工具。

---

### P2 — 锦上添花

#### 8. 批量搜索 API

当前 `memoryGraphSearch` 只支持单次查询。Agent 做 multi-hop reasoning 时需要批量搜索。

```typescript
// memory_batch_search
memoryBatchSearch({
  queries: ["MiPush 团队", "推送到达率优化", "Flutter SDK"],
  maxResultsPerQuery: 3
})
```

#### 9. 记忆统计仪表板

```typescript
// memory_stats
{
  totalEntities: 498,
  totalEdges: 500,
  typeDistribution: { project: 45, person: 30, concept: 120, ... },
  topEntities: [{ name: "MiPush", importance: 0.95, accessCount: 47 }],
  healthScore: 8.2, // 基于孤立节点率、衰减率、重复率
  lastConsolidation: "2026-04-29T23:00:00Z"
}
```

#### 10. embedding 维度自动检测

**问题**：`vecDimensions` 默认 1536，如果换了 embedding 模型（如 768 维的 BGE），需要手动修改配置。

**建议**：首次 embed 时自动检测维度并更新 sqlite-vec 表。

#### 11. 图导出格式增强

当前支持 Mermaid/DOT/JSON，可增加：
- **Cypher** 格式（直接导入 Neo4j）
- **GraphML** 格式（Gephi 可视化）
- **Turtle/RDF** 格式（语义 Web 兼容）

#### 12. confidence 动态衰减曲线

当前衰减是线性乘法（`* 0.9` 或 `* 0.8`），建议改为基于访问频率的非线性衰减：

```typescript
// 被频繁访问的实体衰减更慢
const decayFactor = entity.access_count > 10 ? 0.95
  : entity.access_count > 5 ? 0.9
  : 0.8;
```

---

## 四、对标竞品差距分析

### vs mem0
| 特性 | MEM-C | mem0 |
|------|-------|------|
| 存储 | SQLite（零依赖）| Qdrant/Pinecone/ChromaDB（需部署）|
| 知识图谱 | ✅ 内建 | ✅ 2025 年新增 |
| 实体消解 | name+type 精确匹配 | embedding 语义匹配 |
| API 简洁度 | MCP 工具 | `m.add()`/`m.search()` |
| **MEM-C 优势** | 零部署成本、L0/L1/L2 分层注入、时间版本化 |
| **mem0 优势** | 语义去重更智能、云原生扩展性 |

### vs Letta/MemGPT
| 特性 | MEM-C | Letta |
|------|-------|-------|
| 记忆管理 | 被动提取 | Agent 自主编辑 |
| 上下文管理 | L0/L1/L2 自动分层 | Main context + archival + recall |
| 运行模式 | MCP plugin | 独立 agent 框架 |
| **MEM-C 优势** | 轻量集成、图遍历、社区检测 |
| **Letta 优势** | 自主记忆管理、双层上下文更灵活 |

### vs Zep
| 特性 | MEM-C | Zep |
|------|-------|-----|
| 时序推理 | valid_from/until 版本化 | Temporal fact graph |
| 实体提取 | LLM 单次提取 | Enrichment pipeline（多阶段）|
| 部署 | 零依赖 | 需要 PostgreSQL + 其他服务 |
| **MEM-C 优势** | 零部署、图遍历路径查找 |
| **Zep 优势** | 更成熟的 entity resolution、时序推理 |

### vs GraphRAG (Microsoft)
| 特性 | MEM-C | GraphRAG |
|------|-------|----------|
| 社区检测 | BFS 连通分量 | Leiden 层次化社区 |
| 搜索模式 | 混合检索 | Global search + Local search |
| 定位 | Agent 记忆 | 文档知识索引 |
| **MEM-C 优势** | 实时增量更新、会话记忆 |
| **GraphRAG 优势** | 层次化社区摘要、global search 能力 |

---

## 五、架构演进建议

### 短期（1-2 周）
1. 语义去重（P0）
2. 边合并去重（P0）
3. Episode 索引优化（P1）

### 中期（1-2 月）
4. 社区检测升级到 Leiden（P1）
5. 搜索权重自适应（P1）
6. 记忆自省工具（P1）

### 长期（3-6 月）
7. 多 agent 共享记忆（namespace 已有基础）
8. 记忆压缩/摘要（对大量 episode 做 rolling summary）
9. 可选的分布式后端（SQLite → PostgreSQL + pgvector）

---

## 六、竞品调研补充发现

详细调研报告见 [2026-04-30_competitive-research.md](2026-04-30_competitive-research.md)

### 竞品调研确认的关键差距

1. **事实冲突检测**（Zep 已实现）— MEM-C 的 `extractAndMerge` 只做 upsert，不检测新旧事实矛盾。应在提取 prompt 中增加冲突判断指令，对标 Zep 的事实失效检测。

2. **Rerank 集成**（mem0/Zep 已实现）— `rerankFn` 接口已定义但未内置默认实现。建议内置基于 embedding 的二次排序，或支持 Cohere/Jina Reranker API。

3. **层级社区检测**（GraphRAG 已实现）— BFS 连通分量 vs Leiden 的差距不仅是算法精度，更是层次化摘要能力（社区的社区）。

4. **Tag 编码**（OpenViking 已实现）— OpenViking 的 tag 系统（sentiment/entities/category/source）让记忆可以多维度过滤。MEM-C 的 entity 只有 type 字段，缺少 tag 维度。

5. **生命周期 Hook**（claude-mem 已实现）— claude-mem 在每次工具调用后（PostToolUse）自动提取 observation，比 MEM-C 的会话结束时提取捕获更多细节。

### MEM-C 独特优势（竞品没有的）

- **L0/L1/L2 分层注入** — Letta 的 core/archival/recall 是存储层分层，MEM-C 的 L0/L1/L2 是注入层分层，更省 token
- **时间有效性版本化** — valid_from/until 方案在 12 个竞品中唯一
- **零基础设施** — 在"零基础设施"象限中功能最丰富（vs knowledge-graph-memory 的 JSON 文件方案）
- **知识图谱遍历** — 图路径查找、社区检测是 OpenViking 和 claude-mem 都没有的

---

## 七、值得保留的设计决策

以下设计在竞品中是独特的或领先的，应坚持：

1. **零外部依赖**：SQLite 单文件是最务实的选择，500 以下实体的场景完胜任何分布式方案
2. **L0/L1/L2 分层注入**：这个设计比 mem0/Letta 的扁平检索更省 token
3. **时间有效性版本化**：valid_from/until 比简单的"覆盖写"保留了完整历史
4. **content_hash 增量 embed**：避免重复计算，节省 API 成本
5. **重要度评分公式**：recency + degree + access + confidence 的加权组合是合理的
6. **namespace 隔离**：为多用户/多 agent 场景预留了扩展空间
