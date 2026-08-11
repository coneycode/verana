# 多轮对话式澄清设计

[LOCKED] 2026-08-10

## 背景

现有澄清是批量表单模式：一次性生成3-7个问题 → 用户批量回答 → 二次校验追问。
不足以支撑复杂任务的澄清。复杂任务需要多轮对话逐步明确目标边界。

## 核心变化

从"表单填空"变成"对话式澄清"。系统一次只问一个问题，根据用户回答决定下一个问题或判定信息足够。

## 交互流程

```
用户进入 → 系统生成第一个问题 → 用户回答 → 系统根据回答生成下一个问题 → ... → 系统判定 done
→ 展示"澄清结论"卡片(每话题一个结论) → 用户确认或继续补充
→ 确认 → goal_confirmed → 触发 plan
```

### 交互细节

1. 对话进行中：一问一答的气泡，自然对话
2. LLM 判定 done → 前端展示"澄清结论"卡片：
   - 列出每个 topic + conclusion
   - 用户可以"确认，开始规划"或"继续补充"
3. 用户确认 → goal_confirmed → 触发 plan
4. 用户选择"继续补充" → 回到对话模式，LLM 根据用户补充内容继续对话或再次判定 done

## 数据结构

### ClarifierRecord

```typescript
interface ClarifierRecord {
  status: "clarifying" | "goal_confirmed";
  messages: Array<{ role: "assistant" | "user"; content: string }>;
  conclusions?: Array<{ topic: string; conclusion: string }>;
}
```

- messages: 平铺对话记录，assistant 是系统问的问题，user 是用户的回答
- conclusions: LLM 判定 done 时返回的结构化结论，每话题一个

### 兼容性

旧项目 status 里有 clarifications 字段（q/a/risk 格式），在 clarifyChat 里自动转成 messages 格式：
- q → { role: "assistant", content: q }
- a → { role: "user", content: a }

## 后端 API

### POST /projects/:id/clarify-chat

请求体：`{}`

后端逻辑：
1. 读 goal + messages
2. 调 LLM（clarifyChat 函数）
3. LLM 返回 action=ask 或 action=done

返回：
- `{ type: "question", topic: "任务性质", content: "问题文本" }`
- `{ type: "done", conclusions: [{ topic: "任务性质", conclusion: "..." }] }`

### POST /projects/:id/clarify-answer

请求体：`{ answer: "用户回答" }`

后端逻辑：
1. 追加 user message 到 messages
2. 调 LLM 获取下一个问题或判定 done
3. 如果 done，写入 conclusions，但 status 保持 clarifying（等用户确认）

返回：
- `{ type: "question", topic: "...", content: "..." }`
- `{ type: "done", conclusions: [...] }`

### POST /projects/:id/clarify-confirm（新增）

请求体：`{}`

后端逻辑：
1. 设 clarifier.status = "goal_confirmed"
2. 触发 plan（fire-and-forget）

返回：`{ ok: true }`

## LLM 调用

### CLARIFY_CHAT_SYSTEM

```
你是一个方案澄清助手。根据用户目标和已有对话，生成下一个澄清问题或判定信息足够。

返回 JSON:
{ "action": "ask", "topic": "话题标签(2-6字)", "question": "问题", "reason": "为什么问这个" }
或
{ "action": "done", "conclusions": [{ "topic": "话题", "conclusion": "该话题的最终澄清结论" }] }

规则:
- 一次只问一个问题
- 问题要基于已有对话上下文，不重复已问过的
- 如果用户回答模糊，追问具体细节
- 覆够关键维度后判定 done: 任务性质/产出形式/范围边界/验收标准/约束条件
- done 时必须返回 conclusions: 每个已澄清话题提炼一个结论(一句话)
- 用中文，口语化，像人对话一样自然
```

### clarifyChat 函数

```typescript
export async function clarifyChat(state: ProjectState, client: LlmClient): Promise<
  | { type: "question"; topic: string; content: string }
  | { type: "done"; conclusions: Array<{ topic: string; conclusion: string }> }
> {
  const goal = state.project.goal;
  const messages = state.status.clarifier?.messages ?? [];

  const dialogueText = messages.map(m => `${m.role === "assistant" ? "系统" : "用户"}: ${m.content}`).join("\n");
  const userPrompt = `目标: ${goal}\n\n对话历史:\n${dialogueText || "(无)"}\n\n请生成下一个问题或判定信息足够。`;

  const result = await client.completeJson<{
    action?: string;
    topic?: string;
    question?: string;
    reason?: string;
    conclusions?: Array<{ topic?: string; conclusion?: string }>;
  }>("composer", CLARIFY_CHAT_SYSTEM, userPrompt);

  if (result.action === "done" && result.conclusions?.length) {
    return {
      type: "done",
      conclusions: result.conclusions
        .filter(c => c.topic && c.conclusion)
        .map(c => ({ topic: c.topic!, conclusion: c.conclusion! })),
    };
  }

  return {
    type: "question",
    topic: result.topic ?? "通用",
    content: result.question ?? "请补充更多信息。",
  };
}
```

### buildGoalSummary

从 conclusions 生成目标总结（给 Composer 用）：

```typescript
export function buildGoalSummary(state: ProjectState): string {
  const conclusions = state.status.clarifier?.conclusions ?? [];
  const lines = ["# Goal Confirmation", "", `Raw goal: ${state.project.goal}`, "", "## Clarified Conclusions", ""];
  for (const c of conclusions) {
    lines.push(`- [${c.topic}] ${c.conclusion}`);
  }
  return `${lines.join("\n")}\n`;
}
```

Composer 拿到的是结构化结论列表（短且精准），不是原始对话记录。

## 前端

### 对话气泡界面

```
┌──────────────────────────────────────┐
│  澄清目标                             │
│                                      │
│  ┌────────────────────┐              │
│  │ 系统: 这份调研的...  │              │  ← assistant 气泡(左)
│  └────────────────────┘              │
│              ┌────────────────────┐  │
│              │ 用户: 用于求职准备  │      │  ← user 气泡(右)
│              └────────────────────┘  │
│  ┌────────────────────┐              │
│  │ 系统: 需要覆盖哪些...│              │
│  └────────────────────┘              │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ 输入回答...            [发送] │    │  ← 输入框
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

### 结论卡片（action=done 时）

```
┌──────────────────────────────────────┐
│  ✓ 澄清完成                          │
│                                      │
│  [任务性质] 调研九昆致知在AI大模型... │
│  [产出形式] PPT格式，结构清晰...      │
│  [范围边界] 聚焦中国大陆，2024-2026  │
│  [验收标准] 覆盖技术/应用/团队/融资   │
│                                      │
│  [确认，开始规划]  [继续补充]         │
└──────────────────────────────────────┘
```

### 前端逻辑

1. 首次进入 created/clarifying → 调 POST /clarify-chat → 渲染第一个问题气泡
2. 用户输入回答 → POST /clarify-answer → 渲染用户气泡 + 下一个问题气泡或结论卡片
3. 结论卡片"确认" → POST /clarify-confirm → 等待 plan 完成
4. 结论卡片"继续补充" → 显示输入框 → 用户输入 → POST /clarify-answer → 继续

### CSS

- assistant 气泡：左对齐，圆角，背景 var(--surface)
- user 气泡：右对齐，圆角，背景 var(--accent-bg)
- 结论卡片：居中，带边框，每条结论一行
- 输入框：底部固定，支持 Enter 发送

## 不变的部分

- doPlan() 逻辑不变（goal_confirmed → plan）
- workflow 后续流程不变
- rerun-from 到澄清阶段：重置 clarifier 为空 messages
