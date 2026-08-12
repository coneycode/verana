# 交付物问答设计

## 核心功能

项目 approved 后，用户可以针对最终交付物提问。系统从 evidence/report 文件里检索相关内容，注入 LLM 上下文回答。

## 交互

- approved 阶段：交付物 tab 旁边加一个"问答"tab
- 对话式：用户提问 → 系统检索 + 回答 → 继续提问
- 记住对话历史，支持多轮追问
- 支持"清空上下文"按钮，重置对话

## 检索方案

不做 embedding，用关键词检索 + LLM 判断：

1. 用户提问 → 从所有 evidence/report 文件中按关键词匹配（标题+内容里的关键词重叠）
2. 取匹配度最高的 2-3 个文件，截取相关段落
3. 注入 LLM 上下文 + 对话历史 → 生成回答

关键词检索逻辑：
- 提取用户问题里的关键词（去停用词，保留名词/数字/专有名词）
- 对每个文件计算关键词命中次数
- 取命中次数最高的文件

## 后端 API

### POST /projects/:id/qa-chat

请求体：`{ question: "用户问题" }`

后端逻辑：
1. 读取所有 evidence 文件 + report 文件
2. 关键词检索：从问题提取关键词，匹配文件，取 top 2-3
3. 截取相关文件的段落（命中关键词的段落 + 前后文）
4. 组装 LLM prompt：检索到的上下文 + 对话历史 + 用户问题
5. 调 LLM 生成回答
6. 返回 `{ answer: "回答内容", sources: ["文件名1", "文件名2"] }`

### POST /projects/:id/qa-clear

请求体：`{}`

后端逻辑：清空对话历史（不删文件，只清 qa_messages）

## 数据结构

### ProjectState 加 qa_messages

```typescript
interface ProjectState {
  // ... 现有字段
  qa_messages?: Array<{ role: "user" | "assistant"; content: string }>;
}
```

qa_messages 存在 status.yaml 里，和 clarifier 的 messages 类似。

## 检索实现

```typescript
function retrieveRelevantFiles(question: string, files: Array<{ path: string; content: string }>): Array<{ path: string; content: string }> {
  // 提取关键词：去掉常见停用词，保留有意义的词
  const stopWords = new Set(["的", "是", "了", "在", "和", "与", "或", "也", "都", "这", "那", "什么", "怎么", "哪个", "哪些", "多少", "请", "帮", "一下", "我", "你", "他", "它", "有", "没有", "不", "没", "可以", "能", "会", "吧", "呢", "啊", "吗"]);
  const keywords = question
    .replace(/[，。？！、\s]+/g, " ")
    .split(" ")
    .filter(w => w.length >= 2 && !stopWords.has(w));
  
  if (keywords.length === 0) return files.slice(0, 3); // 无关键词，取前3个
  
  // 计算每个文件的命中次数
  const scored = files.map(f => {
    let score = 0;
    for (const kw of keywords) {
      const count = (f.content.match(new RegExp(escapeRegex(kw), "gi")) || []).length;
      score += count;
    }
    return { ...f, score };
  });
  
  // 按命中次数排序，取 top 3
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).filter(f => f.score > 0).length > 0 
    ? scored.slice(0, 3).filter(f => f.score > 0) 
    : scored.slice(0, 3); // 全0命中时取前3个
}
```

## LLM 调用

### QA_CHAT_SYSTEM

```
你是一个文档问答助手。根据提供的检索上下文和对话历史，回答用户关于项目交付物的问题。

规则：
- 只基于提供的检索上下文回答，不要编造信息
- 如果上下文里没有相关信息，说"根据现有资料，没有找到相关信息"
- 引用数据时标注来源文件
- 用中文回答
```

### 组装 prompt

```
检索上下文(从交付物文件中提取的相关内容):
--- {file1} ---
{相关段落}

--- {file2} ---
{相关段落}

对话历史:
用户: ...
助手: ...

用户问题: {question}

请回答。
```

## 前端

### approved 阶段加 tab 切换

在现有交付物 tab 旁加"问答"tab：
- 交付物 tab：现有 tab 切换布局（evidence + report 文件内容）
- 问答 tab：对话气泡界面（和澄清环节一样的 chat UI）
  - 用户气泡（右）+ 助手气泡（左）
  - 输入框 + 发送按钮
  - "清空上下文"按钮
  - 助手回答显示引用来源文件名

## 不变的部分

- 澄清环节不变
- 规划/执行/review 流程不变
- 交付物 tab 切换不变

## 改动文件

1. types.ts — StatusRecord 加 qa_messages
2. server.ts — POST /projects/:id/qa-chat + qa-clear 路由
3. 新文件 qa.ts — retrieveRelevantFiles + qaChat 函数
4. app.js — approved 阶段 tab 切换（交付物/问答）
5. web.ts — 无新 CSS（复用 chat CSS）
