# Verana v2 — Runtime Kernel / Artifact Contract 落地规格

状态: [LOCKED] 运行时事实层规格(已实现)
最后更新: 2026-07-23
关联总纲: `docs/design/v2-orchestration-design.md`

本文不是原则说明,而是给代码实现用的运行时内核规格。目标是把“先建立事实层,再让 LLM 做语义判断”落成确定性流程,避免 claim / stream / deliverable 混用导致简单错误反复出现。

---

## 1. 设计目标

Runtime Kernel 是 Verana 执行阶段的事实层。它负责在 executor 与 verifier 之间插入一层确定性的 artifact 收集、冻结、机械校验与事件记录。

它必须保证:

1. **claim 不能成为 deliverable**
   - executor 的最终回复只写入 `claim.md`。
   - engine 不得把 claim 当作正式正文写入 `node.outputs`。
   - engine 不得在 `node.outputs` 缺失时用 claim 兜底。

2. **verifier 只看冻结 artifact snapshot**
   - 重节点 verifier 的正文输入只能来自 `runs/<run-id>/artifacts/`。
   - verifier 不得直接读取 executor stdout、claim、未冻结的工作区文件。

3. **机械事实先于语义判断**
   - 文件是否存在、是否为空、是否像过程日志、是否符合声明结构,都由代码先判。
   - 机械契约失败时不调用语义 verifier,直接生成 artifact failure verdict。

4. **失败必须可归因**
   - artifact contract 失败统一归入 `F_artifact_contract_failure`。
   - diagnostician 可以读取 claim + artifact report + instruction + blackboard 来解释根因,但不得改写事实。

---

## 2. 核心对象定义

### 2.1 Claim

Claim 是 executor 对本次 run 的自述证词。

落盘位置:

```text
runs/<run-id>/claim.md
```

来源:

- Hermes / Claude Code / coding agent 的最终 stdout 摘要或 `claim` 字段。
- 轻节点 LLM 的返回文本,若该轻节点本身就是判断类输出。

约束:

- Claim 永远是 `UNVERIFIED`。
- Claim 可以供 UI 展示、debug、diagnostician 归因。
- Claim 不得被写入 `node.outputs`。
- Claim 不得作为 verifier 的交付物正文输入。

### 2.2 Stream

Stream 是 executor 运行过程日志。

落盘位置:

```text
runs/<run-id>/stream.md
```

约束:

- 只供观察和调试。
- 不参与交付物生成。
- 不作为 verifier 输入。
- 若 artifact 内容高度类似 stream 摘要,应判 artifact contract fail。

### 2.3 Declared Outputs

Declared Outputs 是 capability node 在 `workflow.yaml` 中声明的正式产物路径。

示例:

```yaml
capabilities:
  - id: write_evaluation
    kind: agent
    outputs:
      - path: solution/evaluation.md
        desc: 评估报告正文
```

约束:

- 对 agent 重节点,`outputs` 必填,至少一个。
- `outputs[].path` 必须是项目目录内相对路径。
- 不允许绝对路径。
- 不允许 `..` 越界。
- 不允许指向 `runs/<run-id>/claim.md`、`stream.md`、`verdict.yaml` 等运行日志文件。
- executor 必须通过文件写入产出这些路径。

### 2.4 Artifact Snapshot

Artifact Snapshot 是 runtime kernel 从 declared outputs 复制/冻结出来的不可变物证。

落盘位置:

```text
runs/<run-id>/artifacts/
```

约束:

- 每个 declared output 都要映射到 snapshot 内的一个条目。
- snapshot 是 verifier 的唯一正文输入。
- snapshot 建立后 verifier 不再读取原始工作区路径。
- snapshot 内容必须可以在 UI 中与 claim 并排展示。

建议映射:

```text
node.outputs[0].path = solution/evaluation.md
snapshot path        = runs/<run-id>/artifacts/solution/evaluation.md
```

保留原相对路径结构可以方便定位原文件,也避免多个同名文件冲突。

### 2.5 Artifact Report

Artifact Report 是机械契约检查报告。

落盘位置:

```text
runs/<run-id>/artifact-report.yaml
```

它是代码生成的事实报告,不是 LLM 输出。

最小结构:

```yaml
passed: false
run_id: run-0003
node_id: write_evaluation
checked_at: "2026-07-15T00:00:00.000Z"
outputs:
  - declared_path: solution/evaluation.md
    snapshot_path: runs/run-0003/artifacts/solution/evaluation.md
    exists: true
    is_file: true
    size_bytes: 1874
    line_count: 47
    status: failed
    failures:
      - code: artifact_looks_like_process_log
        message: 内容高比例是执行过程自述,不像正式正文
summary:
  failure_class: F_artifact_contract_failure
  message: declared outputs did not produce valid artifacts
```

---

## 3. 类型与数据模型

### 3.1 CapabilityNode 输出契约

当前 `CapabilityNode.outputs?: Array<{ path: string; desc: string }>` 需要升级为明确 artifact contract。输出还必须标注 role,区分 raw evidence 与正式 deliverable。

建议类型:

```ts
export type ArtifactKind = "file" | "directory";

export type OutputRole = "evidence" | "deliverable" | "intermediate";

export interface OutputContract {
  path: string;
  desc: string;
  kind?: ArtifactKind;             // 默认 file
  role?: OutputRole;               // 默认 deliverable
  required?: boolean;              // 默认 true
  materializable?: boolean;        // 默认 role !== evidence
  min_bytes?: number;              // 默认按节点类型/文件类型推断
  min_lines?: number;              // markdown/text 常用
  format?: "markdown" | "json" | "yaml" | "text" | "directory";
  must_not_look_like?: Array<"claim" | "stream" | "process_log" | "metadata_only">;
}

export interface CapabilityNode {
  // ...已有字段
  outputs?: OutputContract[];
}
```

第一版可以不一次性暴露所有字段给 Composer,但内部 validator 应按默认值补齐。

role 语义:

- `evidence`: 原始证据、来源摘录、浏览结果、事实笔记。允许不满足最终交付物章节模板,但不能为空、不能只有操作日志。默认 `materializable=false`。
- `deliverable`: 正式交付物。必须满足 deliverable_type 结构契约。默认 `materializable=true`。
- `intermediate`: 中间文件。按 output contract 做基础检查,通常不进入最终结构校验。

### 3.2 ArtifactSnapshot

```ts
export interface ArtifactSnapshotEntry {
  declared_path: string;
  snapshot_path: string;
  kind: "file" | "directory";
  exists: boolean;
  size_bytes: number;
  line_count?: number;
  sha256?: string;
  content_preview?: string;
}

export interface ArtifactSnapshot {
  run_id: string;
  node_id: string;
  root_dir: string;
  created_at: string;
  entries: ArtifactSnapshotEntry[];
}
```

### 3.3 ArtifactReport

```ts
export type ArtifactFailureCode =
  | "outputs_missing"
  | "output_path_unsafe"
  | "declared_output_missing"
  | "declared_output_empty"
  | "declared_output_too_small"
  | "artifact_looks_like_claim"
  | "artifact_looks_like_stream"
  | "artifact_looks_like_process_log"
  | "artifact_metadata_only"
  | "snapshot_write_failed";

export interface ArtifactFailure {
  code: ArtifactFailureCode;
  message: string;
  evidence?: string[];
}

export interface ArtifactOutputReport {
  declared_path: string;
  snapshot_path?: string;
  exists: boolean;
  is_file?: boolean;
  is_directory?: boolean;
  size_bytes?: number;
  line_count?: number;
  status: "passed" | "failed";
  failures: ArtifactFailure[];
}

export interface ArtifactReport {
  passed: boolean;
  run_id: string;
  node_id: string;
  checked_at: string;
  outputs: ArtifactOutputReport[];
  summary: {
    failure_class?: "F_artifact_contract_failure";
    message: string;
  };
}
```

### 3.4 VerdictRecord 引用 artifact

当前 `VerdictRecord` 只有 `passed/method/reasons/evidence`。需要加入 artifact 引用,让 verdict 可审计。

建议扩展:

```ts
export interface VerdictRecord {
  passed: boolean;
  method: CheckMethod | "combined" | "cross_check" | "artifact_contract";
  reasons: string[];
  evidence: string[];
  artifact_report?: string;
  artifact_paths?: string[];
  failure_class?: "F_artifact_contract_failure";
  cross_check_agree?: boolean;
}
```

---

## 4. 状态机

### 4.1 重节点状态流

```text
selected
  → running
  → claim_written
  → artifact_collected
  → artifact_validated
  → verifying
  → done
```

失败旁路:

```text
running
  → claim_written
  → artifact_collected
  → artifact_failed
  → diagnosis
  → scheduler_next_or_human
```

### 4.2 不变量

必须由代码保证:

1. `node.kind === "agent"` 的节点,如果没有 `outputs`, workflow validator 不通过。
2. `outputs` 路径不安全时,节点不得执行。
3. executor 完成后必须先写 `claim.md` 和 `stream.md`,再进入 artifact collect。
4. artifact collect 只读 `node.outputs`,不读 claim。
5. artifact validate 失败时:
   - 写 `artifact-report.yaml`
   - 写 `verdict.yaml` 或 append `verdict` event,method = `artifact_contract`
   - 不调用 LLM verifier
   - 进入 diagnostician,且 F 类优先
6. verifier 被调用时必须满足:
   - `artifact-report.yaml.passed === true`
   - `runs/<run-id>/artifacts/` 至少有一个有效 artifact
   - verifier prompt 中不能包含 claim 作为正文
7. verdict 必须引用 artifact snapshot 路径。

---

## 5. Runtime Kernel 函数契约

建议新增模块:

```text
src/artifacts.ts
```

### 5.1 `normalizeOutputContracts(node)`

职责:

- 将 `node.outputs` 补齐默认值。
- 对 agent 重节点强制 `outputs` 非空。
- 对 light 节点允许无 outputs。

签名:

```ts
export function normalizeOutputContracts(node: CapabilityNode): OutputContract[];
```

默认值:

```ts
{
  kind: "file",
  required: true,
  min_bytes: 200,
  min_lines: 5,
  must_not_look_like: ["claim", "stream", "process_log", "metadata_only"]
}
```

对于 `format: json/yaml`, `min_lines` 可以不作为强条件,但必须能 parse。

### 5.2 `validateOutputPaths(projectDir, contracts)`

职责:

- 检查路径安全。
- 保证 declared output 在项目目录内。
- 禁止输出到 run 内部日志文件。

签名:

```ts
export function validateOutputPaths(projectDir: string, contracts: OutputContract[]): ArtifactFailure[];
```

规则:

- `path` 不能是绝对路径。
- `path` normalize 后不能以 `..` 开头。
- `path` 不能包含空段、NUL 字符。
- `path` 不能匹配:
  - `runs/**/claim.md`
  - `runs/**/stream.md`
  - `runs/**/verdict.yaml`
  - `runs/**/artifact-report.yaml`

### 5.3 `collectArtifacts(projectDir, runDir, node)`

职责:

- 根据 `node.outputs` 从项目工作区读取正式产物。
- 复制到 `runDir/artifacts/`。
- 保留 declared path 的目录结构。
- 生成 snapshot entries。

签名:

```ts
export async function collectArtifacts(args: {
  projectDir: string;
  runDir: string;
  runId: string;
  node: CapabilityNode;
}): Promise<ArtifactSnapshot>;
```

行为:

1. 创建 `runDir/artifacts/`。
2. 对每个 output:
   - 原路径: `join(projectDir, output.path)`
   - snapshot 路径: `join(runDir, "artifacts", output.path)`
3. 如果原路径不存在,不要创建假正文;记录 `exists=false`。
4. 如果原路径是文件,复制文件。
5. 如果原路径是目录,递归复制目录,但第一版可限制目录大小并在超限时报错。
6. 计算 size / line_count / sha256 / preview。

禁止行为:

- 禁止读取 claim 作为 fallback。
- 禁止把 executor `content` 写入 output path。
- 禁止 verifier 直接读取原路径。

### 5.4 `validateArtifactContract(snapshot, node)`

职责:

- 对 artifact snapshot 做确定性检查。
- 生成 `ArtifactReport`。

签名:

```ts
export async function validateArtifactContract(args: {
  snapshot: ArtifactSnapshot;
  node: CapabilityNode;
}): Promise<ArtifactReport>;
```

必检项:

1. outputs 非空。
2. required output 必须存在。
3. 文件 size >= `min_bytes`。
4. markdown/text 文件 line_count >= `min_lines`。
5. 内容不能像 claim / stream / process log。
6. 内容不能只有元数据统计而无正文。
7. json/yaml 格式必须 parse 成功。

### 5.5 `artifactFailureVerdict(report)`

职责:

- 将机械契约失败转换成 verdict。
- 不调用 LLM。

签名:

```ts
export function artifactFailureVerdict(report: ArtifactReport): VerdictRecord;
```

输出要求:

```ts
{
  passed: false,
  method: "artifact_contract",
  reasons: report.outputs.flatMap(o => o.failures.map(f => f.message)),
  evidence: [...deterministic evidence...],
  artifact_report: "runs/<run-id>/artifact-report.yaml",
  artifact_paths: [...snapshot paths...],
  failure_class: "F_artifact_contract_failure"
}
```

### 5.6 `renderArtifactForVerifier(snapshot, report)`

职责:

- 只把 artifact snapshot 渲染给 verifier。
- 不包含 claim 正文。

签名:

```ts
export async function renderArtifactForVerifier(snapshot: ArtifactSnapshot): Promise<string>;
```

渲染格式:

```markdown
# Artifact Snapshot

## solution/evaluation.md

<冻结文件正文>
```

若多文件,按 declared outputs 顺序拼接。每个文件保留路径标题。

---

## 6. 机械校验规则

### 6.0 交付物结构契约

artifact contract 解决的是“有没有真实物证”,但不同 deliverable_type 还要满足不同的内容结构。该结构约束必须写进 spec / prompt / validator,不能只靠 verifier 的泛化 rubric。

#### 6.0.1 通用原则

- 交付物必须先像“正式正文”,再谈语义好坏。
- 叙事性过程日志、思维记录、流水账、清单堆砌,都不能直接当正式交付物。
- 不同 deliverable_type 要有不同的结构模板;模板缺失视为 deliverable contract fail。

#### 6.0.2 Research 类型

Research workflow 必须拆成两类能力节点:

1. `collect_evidence`: 收集事实、来源、页面信息和原始调研笔记,输出 `role=evidence` 的 raw artifact,例如 `solution/evidence/raw_research.md`。该节点不负责最终正文结构。
2. `write_structured_research`: 读取 evidence outputs,沉淀正式结构化正文,输出 `role=deliverable` 的 report,例如 `solution/research_report.md`。

完成标准和最终 verifier 必须指向 `role=deliverable` 的结构化报告,不能把 raw evidence 当最终交付物。

Research 交付物默认必须具备:

- **通用结构**: 至少有产品概览、主要发现、结论与建议等正式章节,避免把过程笔记当成正文。
- **项目专属章节**: 如果当前项目的澄清/acceptance/hard_constraints 明确要求评测 3 维、可观测 5 维、功能矩阵或其他专题章节,这些要求应进入当前项目的 deliverable contract,而不是写死进 research 类型默认值。
- **contract 来源**: 当前项目的 deliverable contract 由澄清结果 + acceptance + hard_constraints + deliverable_type 通用底线合成;通用 research 只保留产品概览/主要发现/结论与建议等底线结构。
- **来源与证据**: 每个结论应能回到来源或证据片段。
- **禁止项**: 纯过程叙事、调研思维记录、只讲“我查了什么”但不落结论。

建议结构:

```md
## 产品概览
## 主要发现
## 结论与建议
```

对于当前这类竞品研究,Composer 会根据 acceptance/hard_constraints 额外注入 `评测3维`、`可观测5维`、`功能矩阵` 等项目专属章节。

#### 6.0.3 Creative 类型

Creative 交付物默认必须具备:

- 明确的正文分段或章节结构
- 连贯性检查点(人物/情节/章节承接,按任务类型决定)
- 禁止把创作过程笔记误写成正文

#### 6.0.4 Implementation 类型

Implementation 交付物默认必须具备:

- 问题/目标
- 方案或改动说明
- 实现细节
- 验证方式/测试
- 风险或后续工作

#### 6.0.5 Validator 职责

机械校验必须先做结构检查:

1. 标题/章节是否齐全
2. 是否包含 deliverable_type 对应的必需块
3. 是否包含明显过程话术或流水账痕迹
4. 是否满足最小长度/最小条目数

结构检查失败时,仍按 contract fail 处理,不直接进入语义 verifier。

### 6.1 过程日志 / claim 识别

第一版不用模型,使用保守启发式。只要命中明显模式,即 fail;不追求覆盖所有情况。

中文过程话术高危模式:

```text
让我
我来
我已经
我会
现在
接下来
很好
已完成
获取到了
收集了足够的信息
我将
我需要
```

英文过程话术高危模式:

```text
I will
I have
I'll
Now I
Let me
I need to
I've gathered
Completed
Done
```

判定建议:

- 取前 40 行与全文采样。
- 若过程话术行数 / 非空行数 >= 0.25,判 `artifact_looks_like_process_log`。
- 若开头 10 行出现 3 个以上过程话术,判 fail。
- 若全文没有章节标题、列表项、正文段落,但有大量“已完成/文件已写入”,判 fail。

### 6.2 元数据-only 识别

判 fail 的情况:

- 只有文件大小、行数、路径列表,没有正文内容。
- 只有“已创建 X 文件 / 包含 Y 部分”的摘要。
- 只有 claim 式完成声明,没有用户要求的正文。

### 6.3 最小内容规则

默认规则:

| format | min_bytes | min_lines | 额外规则 |
|--------|-----------|-----------|----------|
| markdown | 200 | 5 | 至少一个正文段落或列表 |
| text | 200 | 5 | 至少一个正文段落 |
| json | 20 | - | JSON.parse 成功 |
| yaml | 20 | - | YAML parse 成功 |
| directory | - | - | 至少一个非空文件 |

节点可通过 output contract 提高阈值,但不能低于全局安全底线:

```ts
min_bytes >= 20
```

---

## 7. Workflow Validator 落地要求

`src/workflow-validator.ts` 必须新增以下硬校验:

1. agent 节点必须声明 outputs。

```text
capability <id> is agent but has no outputs (artifact contract required)
```

2. outputs path 必须唯一。

```text
capability <id> has duplicate output path: <path>
```

3. outputs path 必须安全。

```text
capability <id> output path escapes project root: <path>
```

4. file_exists checks 的 target 必须对应某个 output path 或明确说明外部路径。

5. llm_rubric checks 不能替代 artifact contract。即使有 llm_rubric,agent 节点也必须有 outputs。

6. 审校类节点 checks 口径(2026-10-12 RRSI 事故新增)。

```text
capability <id> 是审校节点但 checks 照抄了被审对象的标准(命中 N/M 个必需章节名,且无审校口径措辞) — ...
```

- 背景:Composer 偶发(实测 16 项目 3 次)把被审对象(最终报告)的验收标准
  (required_sections/字数/风格)原样抄给审校节点(review_report 等),而审校节点的
  outputs 是审校意见(intermediate)——verifier 把 checks 机械应用到本节点自己的
  artifact snapshot,审校意见文件永远不可能包含报告全文,标准机械上不可满足,
  无论 executor 干多好必现 fail。
- 判定:节点 id/desc 含审校语义(审校|审阅|评审|复核|review) 且 outputs 全为
  intermediate → 若 checks 文本命中 ≥2 个 deliverable_contract.required_sections
  章节名,且不含审校口径措辞(审校|核对|逐项|结论|通过/不通过|检查了) → 拦截。
- 配套(prompt 层,src/pipeline.ts):Composer prompt 增加原则"checks 的验收对象是
  本节点声明的 outputs 产出本身,不是它审阅/引用的对象;审校类节点的 checks 必须描述
  审校意见需要覆盖哪些标准、给出什么形式的结论"。

---

## 8. Graph Engine 落地改造点

当前引擎中必须移除/禁止的模式:

```ts
const deliverable = content;
await writeFile(join(runDir, "deliverable.md"), deliverable, "utf8");
await writeFile(outPath, deliverable, "utf8");
```

原因:

- `content` 是 claim 或 raw stdout。
- 这会把自述污染为正式 deliverable。
- 这会掩盖 executor 没有真正写文件的问题。

目标流程:

```ts
const execResult = await executeNode(...);      // 写 stream.md + claim.md
let snapshot = await collectArtifacts({ projectDir, runDir, runId, node });
let report = await validateArtifactContract({ snapshot, node });

if (!report.passed && isMaterializableReport(report, node.outputs)) {
  const materialization = await materializeArtifacts({ claim, stream, snapshot, report, contract });
  await writeYaml(join(runDir, "materialization-report.yaml"), materialization);
  append artifact_materialized / artifact_materialization_failed event;

  if (materialization.passed) {
    snapshot = await collectArtifacts({ projectDir, runDir, runId, node });
    report = await validateArtifactContract({ snapshot, node });
  }
}

await writeYaml(join(runDir, "artifact-report.yaml"), report);

if (!report.passed) {
  const verdict = artifactFailureVerdict(report);
  await writeYaml(join(runDir, "verdict.yaml"), verdict);
  append verdict event;
  diagnose with root cause F priority;
  continue scheduler loop or human escalation;
}

const artifactBody = await renderArtifactForVerifier(snapshot);
const verdict = await verifyAgentNode(..., artifactBody, snapshot, report);
```

`executeNode` 的职责收缩为:

- 组装 instruction。
- 调 executor。
- 写 `stream.md`。
- 写 `claim.md`。
- 不写 `deliverable.md`。
- 不写 `node.outputs` fallback。

`materializeArtifacts` 的职责:

- 只在 artifact contract 失败后运行,且每个 run 最多一次。
- 只处理 `role=deliverable` 且 `materializable !== false` 的 outputs。
- 可修复 missing / empty / too small / claim-like / stream-like / process-log-like / structure-invalid artifacts。
- 输入包括 claim、stream、坏 artifact snapshot、node inputs 和 deliverable contract。
- 输出必须写回声明 output path,然后重新 collect + validate。
- 不得编造输入证据中没有的事实;证据不足时必须失败而不是硬写正文。

`verifyAgentNode` 的职责改为:

- 接收 artifact snapshot/rendered body。
- 不自己回读 `node.outputs`。
- 不 fallback 到 `deliverable.md`。
- verdict evidence 引用 snapshot path。

---

## 9. Diagnostician 与 Scheduler 落地要求

### 9.1 Diagnostician 输入

artifact contract fail 时,diagnostician 输入必须包含:

- node 定义
- instruction
- claim
- artifact report
- artifact snapshot preview
- blackboard
- previous diagnoses

但 prompt 要明确:

```text
Artifact contract has already failed by deterministic scaffold checks.
Prefer F_artifact_contract_failure unless there is strong evidence that the report itself is wrong.
Do not reclassify missing/empty/process-log artifacts as instruction vagueness.
```

### 9.2 Scheduler 行为

当最新 diagnosis 是 `F_artifact_contract_failure` 时:

默认动作:

1. 若失败是 `declared_output_missing` / `output_path_unsafe` / `snapshot_write_failed`:
   - 这是 scaffold / contract 层问题,优先 `human` 或修正 workflow spec,不要盲目重跑。
2. 若失败是 `artifact_looks_like_process_log` / `artifact_looks_like_claim`:
   - 可允许一次重跑,但 instruction 必须强调“必须写 declared output 文件,最终回复不是正文”。
   - 第二次仍 F fail,转人审。
3. 若失败是 `declared_output_too_small`:
   - 可按 A/C 的方式具体化要求后重跑一次。
   - 仍失败则 F 保持,转人审或修 contract。

---

## 10. 事件日志要求

`EventEntry.type` 需要增加:

```ts
| "artifact_collected"
| "artifact_validated"
| "artifact_failed"
```

事件示例:

```json
{
  "type": "artifact_collected",
  "node": "write_evaluation",
  "run_id": "run-0003",
  "data": {
    "snapshot_dir": "runs/run-0003/artifacts",
    "outputs": ["solution/evaluation.md"]
  }
}
```

```json
{
  "type": "artifact_validated",
  "node": "write_evaluation",
  "run_id": "run-0003",
  "data": {
    "passed": false,
    "report": "runs/run-0003/artifact-report.yaml",
    "failure_codes": ["artifact_looks_like_process_log"]
  }
}
```

Progress truth 仍然主要折叠 verdict/diagnosis,但近期明细应能展示 artifact failure:

```text
write_evaluation(run-0003) artifact_failed — artifact_looks_like_process_log
诊断: F_artifact_contract_failure
```

---

## 11. UI / CLI 展示要求

### 11.1 logs

`verana logs <id> [run]` 对重节点应展示四块:

1. Stream — executor 过程日志
2. Claim — agent 自述
3. Artifact Snapshot — 冻结物证
4. Verdict / Artifact Report — 验收与机械契约结论

必须显式标注:

```text
Claim is unverified. Artifact snapshot is verifier input.
```

### 11.2 Web Timeline

timeline 中 artifact failure 不应显示成普通“验证失败”。应显示为:

```text
产物契约失败 — declared output exists but looks like process log
```

并提供 claim/artifact/verdict 并排对比。

---

## 12. 测试清单

### 12.1 Unit: workflow validator

- agent node 没有 outputs → fail。
- light node 没有 outputs → pass。
- output path 是绝对路径 → fail。
- output path 包含 `..` 越界 → fail。
- duplicate outputs → fail。

### 12.2 Unit: artifact collector

- declared output 存在 → 复制到 `runs/<run-id>/artifacts/...`。
- declared output 不存在 → 不创建假文件,report 标 missing。
- 多 outputs 保留目录结构。
- snapshot 不受后续原文件改动影响。

### 12.3 Unit: artifact validator

- 空文件 → `declared_output_empty`。
- 极短文件 → `declared_output_too_small`。
- “让我先...”过程日志 → `artifact_looks_like_process_log`。
- “我已经完成并写入...”claim → `artifact_looks_like_claim`。
- 只有路径/行数统计 → `artifact_metadata_only`。
- 合格 markdown 正文 → pass。

### 12.4 Integration: graph engine

- fake executor 只返回 claim、不写 output:
  - 不生成 output fallback。
  - artifact report fail。
  - verdict method = `artifact_contract`。
  - diagnosis root cause = F。
- fake executor 写合格 output:
  - artifact snapshot 生成。
  - verifier 输入包含 artifact 正文。
  - verifier 输入不包含 claim。
- fake executor 写 process-log 到 output:
  - 不调用 LLM verifier。
  - 直接 artifact failure verdict。
- 重跑后原 output 被修改:
  - 旧 run snapshot 保持不变。

### 12.5 Regression: 已知真实失败

针对真实失败模式建立回归 fixture:

```text
solution/evaluation.md 内容只有 47 行 / 1874 bytes,高比例为“让我/很好/现在...”过程自述。
```

期望:

- artifact validator fail。
- failure code = `artifact_looks_like_process_log`。
- root cause = `F_artifact_contract_failure`。
- scheduler 不把它当普通 `A_instruction_vague` 盲目重试。

---

## 13. 实施顺序

建议按以下顺序落地,每步都可独立验证:

1. **类型与 validator**
   - 扩展 `CapabilityNode.outputs` 内部契约。
   - `workflow-validator.ts` 强制 agent outputs。

2. **新增 `src/artifacts.ts`**
   - path safety
   - collect snapshot
   - mechanical validation
   - artifact failure verdict
   - render artifact for verifier

3. **改 `graph-engine.ts` 执行流**
   - 移除 claim → deliverable/output fallback。
   - execute 后 collect/validate。
   - validate fail 不调用 verifier。

4. **改 verifier 输入**
   - `verifyAgentNode` 只吃 artifact snapshot。
   - verdict 引用 snapshot/report。

5. **改 diagnostician/scheduler F 类处理**
   - artifact failure prompt 明确 F 优先。
   - scheduler 对 F 做契约修复/人审优先。

6. **补事件/UI/CLI 展示**
   - artifact_collected / artifact_validated 事件。
   - logs 展示 claim/artifact/verdict/report。

7. **补测试**
   - 先 unit,再 integration,最后真实失败 fixture regression。

---

## 14. 完成定义

这条 runtime kernel 线只有在以下条件全部满足时才算落地:

- 代码里不存在 claim/raw stdout 自动写入 `node.outputs` 的路径。
- agent 节点无 outputs 时 workflow validator 会失败。
- 每个 agent run 都有 `claim.md`、`stream.md`、`artifacts/`、`artifact-report.yaml`、`verdict.yaml` 或等价 verdict event。
- artifact contract fail 时不会调用 LLM verifier。
- verifier prompt 的正文输入只来自 `runs/<run-id>/artifacts/`。
- 真实失败 fixture 被稳定归为 `F_artifact_contract_failure`。
- UI/CLI 能并排展示 claim、artifact snapshot、verdict/report。
