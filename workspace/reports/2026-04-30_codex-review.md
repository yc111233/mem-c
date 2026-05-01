# MEM-C Codex Review（GPT-5.4 via Mify）

> 审查人：OpenAI Codex (azure_openai/gpt-5.4)
> 日期：2026-04-30
> 方法：静态代码审查 + 官方资料对标

---

## P0 — 必须修复

### P0-1: namespace/tenant 隔离不严
- `entity_aliases / communities / community_members / FTS / vec` 都没有 namespace 隔离
- 多处查询完全没带 namespace（邻居扩展、历史查询、episode 查询、vector fallback、community detection）
- `graph-tools.ts` 声明了 `namespace?: string` 但实际没用，给调用方错误的安全预期
- **建议**：namespace 升级为一等约束，所有存储层/查询都强制带 filter

### P0-2: extractor 直接失效旧记忆太危险
- extraction prompt 要求 LLM 输出 `invalidations`，`extractAndMerge` 立刻执行 `invalidateEntity`
- 一次 LLM hallucination 就会永久污染历史（比"漏记"更危险）
- **建议**：抽取阶段改为 append-only，矛盾信息写成 `contradicts/supersedes` 关系，真正 invalidation 由独立 consolidation job 或人工确认

### P0-3: consolidation 自动 merge 太粗糙
- `normalizeEntityName` 后同名就跨 type 自动合并（同名人/项目/文件会被压扁）
- **建议**：改为 entity linking 流程（type compatibility + summary embedding + 共享邻接 + 时间重叠），默认禁止 cross-type auto-merge

### P0-4: community detection 有 correctness bug
- `maxCommunitySize` 达上限时，邻居被 `visited.add()` 标记但没写进 `component`，这些节点永久丢失
- `storeCommunities()` 每次 DELETE 全表，没有 namespace 维度，覆盖整库结果

---

## P1 — 强烈建议

### P1-1: 搜索升级为 query-aware hybrid retrieval
- `graphScore` 只是邻接边数量归一化（奖励 hub），不是真正的图信号
- vector fallback 只扫最近 5000 条，老但相关的记忆被系统性漏掉
- **建议**：四段式 pipeline — query extraction → multi-signal retrieval → focal-node rerank → evidence packing

### P1-2: community 层没有进入 retrieval loop
- `summarizeCommunities()` 只产出短 label，`searchGraph()` 完全不消费 community
- **建议**：新增 global search 路径（community reports + map/reduce），根据 query 类型切换 local/global

### P1-3: episode/provenance 过薄
- episode 只存 2000 字符截断，没有 text unit、source span、claim 级 provenance
- **建议**：拆成 text units / utterance chunks，保存 source offsets、speaker、turn

### P1-4: context loader 没有真正的 memory hierarchy
- L0 只是实体 roster，不等于 stable core memory
- **建议**：补 pinned core memory（身份/偏好/约束）+ query-driven L1/L2

---

## P2 — 锦上添花

### P2-1: schema 升级为半结构化图
- 引入 typed properties / covariates（person.location、project.status）

### P2-2: MCP tool surface 不够 production
- 缺 episode management、index rebuild、search mode 切换、namespace filter
- `namespace` 参数是假参数

### P2-3: 缺少 evaluation / observability
- 需要 write correctness、retrieval quality、context efficiency 三组指标

---

## 执行顺序
1. P0-1 + P0-2（止血：隔离 + 写入安全）
2. P0-3 + P1-1（entity linking + 检索重写）
3. P1-2 + P1-3 + P1-4（community + provenance + hierarchy）
4. P2（规模化）
