# 在第三方 Host 插件里程序化驱动 DSH Agent

面向 **Host 侧第三方插件**（`ctx` = Cordis 插件上下文）。版本 `0.2.0-rc.2`。来源以 **`.archive/src/`** 为根；
不在该归档内的文件标 `asar:`（路径在 `D:\dsh\resources\app.asar` 内）。方法名/字段/签名逐字取自源码。

> **核心结论**：不要直接调 `ctx.agentLoop.createAgent(ownerCtx, opts)`。公开面是 `ctx.agents.create()/resume()`，
> 它内部就传 `ownerCtx = ctx.agents.ctx` 并 `Reflect.apply(factory.createAgent, receiver, [ownerCtx, options])`。
> `ownerCtx` 决定**生命周期归属**：owner 纤维卸载 → 该 agent 被销毁。来源 `dsh-agent/lib/types/index.js:174-198`；`dsh-agent-loop/lib/index.js:1851-1871`。

## 0. 最短可用示例：创建 → 发「你好」→ 打印流式回复 → 结束

```js
// my-agent-plugin.js —— 最小 Host 插件（Cordis 插件形态见 §9.1）
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';

export const name = 'my-agent-plugin';
export const inject = ['agents'];            // 'agentLoop' 只在直连 factory 时才需要

export function apply(ctx, config) {
  ctx.effect(() => { run(ctx, config).catch((e) => ctx.logger.warn(e)); return () => {}; }, 'my-agent-plugin.run');
}

async function run(ctx, config) {
  const sessionId = SessionId(`session-${randomUUID()}`);      // 1) 官方 id 生成方式
  const handle = await ctx.agents.create({                     // 2) 创建
    sessionId, meta: { cwd: process.cwd() },                   //    meta.cwd → SessionHeader.cwd
    agentOptions: { provider: config.provider, model: config.model } });
  const agent = handle.agent;

  const off = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {   // 3) 先订阅
    if (subject !== agent) return;                             //   全局事件，必须自己过滤
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') process.stdout.write(frame.chunk.text);
    if (frame.type === 'end') process.stdout.write('\n[done]\n');
  });

  agent.followup(createUserMessage({                           // 4) 提交（等价按回车）
    content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }));
  await agent.whenIdle();                                      // 5) 等整轮跑完
  off();
  await handle.dispose();                                      // 6) 销毁（交给 ctx.effect 托管可省，§1.2）
}
```

逐行官方等价：`` `session-${randomUUID()}` `` + `SessionId()` → `dsh-headless/lib/index.js:313`；`agents.create({sessionId, meta:{cwd}, agentOptions})` → `:316-321`；`followup(createUserMessage({content,source}))` → `:329-335`；`whenIdle()` → `:322,:336`；帧判定 → `:153-188`。

## 1. 创建 Agent

`ctx.agents.create(options)` / `ctx.agents.resume(options)` 都返回 `AgentHandle`。`dsh-agent/lib/types/index.js:174-198`：

```js
async create(options) {
  const ownerCtx = this.ctx;                        // ← 就是 AgentRegistry 自己的 ctx
  const { target } = this.requireFactory();
  const receiver = getTraceable(ownerCtx, target);
  return Reflect.apply(target.createAgent, receiver, [ownerCtx, options]);
}
```

- 没装 driver 抛 `no agent factory registered (load an agent-loop plugin)`（`dsh-agent/lib/types/index.js:18`）。
- factory 由 `AgentLoop` 注册：`super(ctx,"agentLoop")` + `ctx.effect(() => ctx.agents.setFactory(this), 'agentLoop.setFactory()')`（`dsh-agent-loop/lib/index.js:1552,1563`）。
- 查询：`ctx.agents.get(id)→Agent|undefined`、`list()`、`roots()`、`isOwnedBy(id,parent)`（`dsh-agent/lib/types/index.js:349-380`）。
- **`ownerCtx` 传什么**：`createAgent` 的 `ownerCtx` = 「调用者上下文，结构性拥有该生命周期」（`dsh-agent-loop/lib/index.js:1847`）——内部 `ownerCtx.fiber.assertActive()` 后 `ownerCtx.effect(function*(){ machine = new ReactLoopAgent(...); ... })`（`:1655-1722`）。走 `ctx.agents.create()` 时 ownerCtx = `AgentRegistry.ctx`（agent 服务卸载才销毁）；走 `ctx.agentLoop.createAgent(myCtx, opts)` 时**传你自己的插件 `ctx`**，agent 随你的插件卸载而销毁。`options.parentAgent` 传另一 `Agent` → 登记为运行时子 agent。

### 1.1 `sessionId` 生成（有官方品牌构造器，无 uuid 生成器）

`SessionId(id) = brandString(id)`，从 `@deepseek-ai/dsh-session` 主入口导出（`dsh-session/lib/types/types.js:7-9`）。官方实际用法：一次性新会话 `` SessionId(`session-${randomUUID()}`) ``（`dsh-headless/lib/index.js:313`）；fork `` brandString(`session-${randomUUID()}`) ``（`dsh-api-session-controller/lib/index.js:806`）；config agent `` brandString(`${id}-session-${randomUUID()}`) ``（`dsh-agent-loop/lib/index.js:1570`）；webhook `` brandString(`webhook-${randomUUID()}`) ``（`dsh-webhook/lib/index.js:162`）。硬约束：`agent.id === agent.session.id`，否则抛 `` agent id "x" does not match session id "y" ``（`dsh-agent/lib/types/index.js:241-243`）。

### 1.2 `meta` / `agentOptions` / `setup` / dispose

`createAgent` 消费：`sessionId`、`seed`、`meta`、`inheritedEventCount`、`agentOptions`、`setup`、`signal`、`parentAgent`（`dsh-agent-loop/lib/index.js:1851-1867`）。

```js
const handle = await ctx.agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  meta: { cwd: 'D:\\work\\demo', agentPreset: 'creator', parentSession: undefined, isSeeded: false },
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: undefined, maxTokens: undefined },
  setup: async (agentCtx, agent) => {                 // 发布前运行；agentCtx === agent.ctx
    agentCtx.tools.register({ /* 仅此 agent 可见的工具 */ });
    installModelSelection(agentCtx, { current: { provider, model }, assembled: undefined }); },
  signal: undefined });                               // AbortSignal，可取消创建
await handle.dispose();                               // 停止 loop → 注销 registry → 移除 session → 回卷 scope
```

- `agentOptions` 可整体省略（内部 `options.agentOptions ?? {}`，`:1867`）；缺 provider/model → 走到模型请求时抛 `` agent "x" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall ``（`:1185`）。唯一主动校验：`maxTokens` 必须正安全整数（`assertAgentOptions`，`:1476-1478`）；部署默认模型取 `ctx.agentDefaultModel.currentSelection() → { provider, model, reasoningEffort? }`（`dsh-api-session-controller/lib/index.js:461-466`）。
- `meta` 落到 `SessionHeader`（字段见 §3.1）。`setup` 只做组合注册，**不能驱动 agent**（`dsh-agent/README.md:43`）；`installModelSelection` 从 `@deepseek-ai/dsh-agent` 导入，签名 `(agentCtx, selection)`（`dsh-agent/lib/types/model-selection.js:45`）；`agent/created` 监听器里**不能** `await agent.whenIdle()` 或等自己 owner 销毁（`dsh-agent/README.md:177`）。
- dispose 内部顺序（`dsh-agent-loop/lib/index.js:1677-1709`）：abort → 等 publication → `machine.cancel({kind:'disposed'})` → `await machine.whenIdle()` → `await machine.scope.dispose()` → `handle.close()`（持久化写句柄）→ detach agent/session → untrack；幂等（`disposing ??= (async()=>{})()`），异步返回 Promise。
- **必须 dispose**：自己显式创建且不想它活到进程结束，或业务失败要回滚（官方回滚范例 `dsh-webhook/lib/index.js:199-211`）。**可以不 dispose**：owner 纤维卸载会自动销毁（Cordis effect teardown）；推荐把创建放进 `ctx.effect` / `ownerCtx.effect`。handle 是**唯一**能拆掉该 agent 的能力，`ctx.agents.get(id)` 只给裸 `Agent`（`dsh-agent/README.md:118`）。

## 2. 恢复已有会话：`ctx.agents.resume()`

```js
const { agent } = await ctx.agents.resume({
  resumeSessionId: sessionId,          // ← 字段名是 resumeSessionId，不是 sessionId
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx, agent) => {}, parentAgent: undefined, signal: undefined });
```

- 与 create 的差异：用 `resumeSessionId`，无 `meta`/`seed`（`dsh-agent-loop/lib/index.js:1921-1977`）。
- **persistence 未挂载**时（`:1922-1924`，逐字）直接 reject，**没有内存态 resume**：

```js
const persistence = this.runtime.ctx.get("sessionPersistence");
if (persistence === undefined)
  throw new Error("cannot resume: session persistence is not configured (load a dsh-session-persistence backend)");
```

- 加载链路（`:1944-1970`）：`persistence.open(id,'write')` → `handle.read(0, undefined)` → `interruptedTurnClosers(persisted)` 作为普通批次 append（修补崩在半轮的日志）→ `sessions.prepare(id, { seed, meta: handle.header, inheritedEventCount, eventState })` → `setupAndPublish(...,'resume',...)`。
- 官方完整范例（含前置守卫）：`dsh-headless/lib/index.js:241-276`。只读观察（不抢写所有权）：`ctx.sessionQuery.observeSession(id, { signal, projectionMode })`（`dsh-api-session-controller/lib/index.js:1569-1572`；`dsh-headless/lib/index.js:257`）。
- 服务名固定 **`ctx.sessionPersistence`**（`super(ctx,'sessionPersistence')`，`dsh-session-persistence/lib/index.js:261-267`）。官方唯一一等后端 **`@deepseek-ai/dsh-session-persistence-jsonl`**（`asar: .../dsh-session-persistence-jsonl/lib/index.js:2372-2400`：`class JsonlSessionPersistence extends SessionPersistence`，仍占 `ctx.sessionPersistence`；`name='session-persistence-jsonl'` 只是诊断标签）；挂载（`asar: .../dsh-session-persistence-jsonl/README.md:36-48`）`config.root` 必填无默认，`compression: 'zstd'(默认)|'none'`。
- 没有后端：`createStoredSession` 直接 `return undefined` → 会话纯内存，其它行为不变（`dsh-agent-loop/lib/index.js:1819-1821`；`dsh-agent-loop/README.md:115`）。同一会话已有写句柄 → `SessionAlreadyOwnedError`（上层映射 `session/writer-held`，`dsh-api-session-controller/lib/index.js:1008`）。**`sessionLogDeepseek` 在本 build 不存在**（`.archive/src` + app.asar 全量搜索无匹配）——**未确认，勿用**。

## 3. Agent 运行对象的真实接口

逐字来自 typert 清单 `dsh-cordis-host-runner/lib/typert.host.js:873`（同文本 `dsh-api-session-controller/lib/typert.host.js:1581`）：

```ts
export interface Agent {                   // :873（同文本 dsh-api-session-controller/lib/typert.host.js:1581）
  readonly id: SessionId; readonly options: AgentOptions; readonly session: Session;
  readonly inbox: Inbox; readonly status: AgentStatus; readonly ctx: Context;   // status: 'idle' | 'running'
  cancel(cause: AgentCancelCause, options?: CancelOptions): void; whenIdle(): Promise<void>;
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>; send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
  followup(message: UserMessage): void; steer(message: UserMessage): void; inject(message: UserMessage): void; }
export interface AgentOptions { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId; maxTokens?: number; subagentDepth?: number }
export type AgentStatus = 'idle' | 'running';   export type InboxTarget = 'next-turn' | 'next-step';
export interface CancelOptions { keepInbox?: boolean | undefined }
export type AgentCancelCause = { readonly kind: 'user' } | { readonly kind: 'parent' } | { readonly kind: 'hook'; readonly reason: string } | { readonly kind: 'disposed' };
export interface Inbox {                   // :1112-1117
  readonly nextTurn: readonly UserMessage[]; readonly nextStep: readonly UserMessage[];
  clear(): void; append(target: InboxTarget, message: UserMessage): void; prepend(target: InboxTarget, message: UserMessage): void;
  replace(messageId: MessageId, newMessage: UserMessage): boolean; remove(messageId: MessageId): boolean;
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[]; }
```

`send/followup/steer/inject` 真实分发（`dsh-agent-loop/lib/index.js:800-814`）：

```js
send(message, target, wakeup) {
  const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
  this.inbox.splice(wakingAfterAbort ? "next-turn" : target, Infinity, 0, [message]);
  if (wakeup) this.wakeDriver(wakingAfterAbort); }
followup(input) { this.send(input, "next-turn", true); }   // 下一轮 + 唤醒
steer(input)    { this.send(input, "next-step", true); }    // 下一步 + 唤醒
inject(input)   { this.send(input, "next-step", false); }   // 下一步，不唤醒
```

- `agent.status` 实现：`this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'` ——**`maintenance` 也算 `idle`**（`:790-792`）。
- `inbox.nextTurn` = 等单开一轮的 prompt；`inbox.nextStep` = 等下一 step 边界的输入；`hasPending` = 两者非空（`:80-91`）。
- `whenIdle()` 循环等 `activityDone` 稳定（`:870-875`）；`runMaintenance(fn)` 只在 idle 可进，期间 status 仍报 idle（`:822-845`）；状态变化事件 `agent/status` 仅在 status 真变化时 emit（`setPhase`，`:794-799`）。

### 3.1 `Session` 公开面（`dsh-cordis-host-runner/lib/typert.host.js:1276`）

```ts
export interface Session {                  // :1276
  get surface(): SessionSurface; readonly header: SessionHeader; readonly inheritedEventCount: SessionLogOffset; get id(): SessionId;
  readonly firstLiveSeq: SessionLogOffset; readonly firstLifecycleSeq: SessionLogOffset; get seq(): SessionLogOffset;
  eventAt(seq: SessionSeq): SessionEvent | undefined;
  snapshotEvents(fromSeq?: SessionLogOffset, toSeqExclusive?: SessionLogOffset): readonly SessionEvent[];
  ownEvents(): readonly SessionEvent[]; isOwnSeq(seq: SessionSeq): boolean;
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts): SessionEvent<T>;
  requestHeader(): EpochHeader | undefined; requestContext(): RequestContext | undefined;
  toolHistory(): ToolHistory; deriveMessages(): Message[]; deriveEventMessage(event: SessionEvent): Message | null; }
// version 本 build = 4（dsh-session/lib/types/types.js:54）
export interface SessionHeader { readonly version: typeof SESSION_FORMAT_VERSION; readonly id: SessionId; readonly createdAt: number; readonly cwd?: string; readonly parentSession?: SessionId; readonly isSeeded: boolean; readonly origin?: 'subagent'; readonly delegationDepth?: number; readonly agentPreset?: string }
```

其它：`ctx.sessions.get(id) → Session|undefined`、`await ctx.sessions.flush(session)`（`session/flush` 持久化屏障）（`dsh-session/lib/index.js:1832,1861-1862`；用法 `dsh-headless/lib/index.js:340`）。

## 4. 提交一条用户消息（等价 Web UI 按回车）

官方链路 `SessionController.prompt(request)`（`dsh-api-session-controller/lib/index.js:850-899`）核心三行：

```js
const message = createUserMessage({ content: await this.ctx.attachments.admitPromptContent(admission.content), source });
if (request.mode === "steer") agent.steer(message);
else agent.followup(message);
```

`source` 构造（`:856-860`）：`{ kind:'user', rpcId: request.requestId, ...(clientTimeZone 可选) }`。请求/响应形状（`dsh-api-session-controller/lib/typert.host.js` 清单）：

```ts
// 幂等去重：requestId；mode: 'queue' → followup，'steer' → steer
export interface SessionPromptRequest { readonly requestId: SessionRequestId; readonly sessionId: SessionId; readonly mode: 'queue' | 'steer'; readonly content: readonly PromptContentPart[]; readonly clientTimeZone?: string }
export interface SessionPromptValue { readonly accepted: true }
export type PromptContentPart = { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string } | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> };
```
- **纯文本**：`[{ type: 'text', text: '你好' }]`。`requestId` 只在 `SessionController.prompt` 层做幂等（`:855` `if (hasPromptRequest(agent, request.requestId)) return { accepted: true }`）；**直接调 `agent.followup()` 无去重**，需要幂等请自己记 requestId。
- `followup`/`steer` 返回 `void` 且**同步入队**，不表示模型已消费；`prompt` 返回 `{ accepted: true }`；空内容被拒：`prompt content must include non-whitespace text or an attachment`（`:851`）。
- 插件内最小可用：

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm';   // 官方导入路径，见 dsh-headless/lib/index.js:6
agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }));
agent.steer(createUserMessage({ content: [{ type: 'text', text: '先看测试' }], source: { kind: 'plugin', plugin: 'my-plugin' } }));
```

`UserMessage`／`ContentBlock` 确切形状（`dsh-cordis-host-runner/lib/typert.host.js:1444,1063,956`）：

```ts
export interface MessageBase { readonly id: MessageId; readonly content: readonly ContentBlock[]; readonly source: MessageSource }
export interface UserMessage extends MessageBase { readonly role: 'user' }
export interface TextBlock { type: 'text'; text: string }
export type ContentBlock = ContentBlockMap[ContentBlockType];   export type ContentBlockType = keyof ContentBlockMap;
export interface ContentBlockMap { text: TextBlock; reasoning: ReasoningBlock; image: ImageBlock; file: FileBlock; 'tool-call': ToolCallBlock; 'tool-addition': ToolAdditionBlock; 'tool-removal': ToolRemovalBlock; }
```

`MessageSource`（`:1192` `MessageSourceMap`）常见成员：`user: { kind:'user' }`、`'user-rpc': { kind:'user'; rpcId: SessionRequestId; clientTimeZone?: string }`、`'agent-message'`、`'subagent-settled'`、`'skill-invocation'`、`goal`、`schedule`、`'user-question-reply'`。
**并发提交行为**：每次提交是一次 inbox 变更，每个变更都追加一条规范化 `agent/inbox/spliced` 事件并同步 fold 进投影（`dsh-agent-loop/lib/index.js:204-206`；`dsh-agent/README.md:71`）。running 时 `followup` 插 `next-turn` + `phase.wakeRequested = true`，当前轮跑完自动开新轮（`:854-858, 887-900`）。一个 turn 边界只取 **1 条 `next-turn` + 全部 `next-step`**（`claim`：`mutate('next-turn',0,1,[],false)`，`:103-111`）→ 连续 3 次 `followup` 会依次开 3 轮，不是一轮塞 3 条。没有「提交被拒」异常路径；`followup` 同步入队，不 reject。

## 5. 订阅助手输出

### 5.1 流式增量：`agent/assistant-stream`（唯一的进程内实时流）

emit 点（`dsh-agent-loop/lib/index.js:1067-1069`）：

```js
const live = new AssistantStreamAttempt(this.session.id, ++this.assistantAttemptCounter, () => ++this.assistantStreamRevision, turn, step,
  (frame) => { this.dispatch.emit("agent/assistant-stream", { frame }); });
```

帧结构由 `AssistantStreamAttempt` 决定（`:355-472`）；跨进程（Web follower）的同一帧多一个 `startedAfterSeq`（`dsh-api-session-controller/lib/index.js:1593-1603`；wire 类型 `SessionAssistantStreamFrame` 见其 typert.host.js）：

```ts
// 进程内 Frame 是三项并集（wire 版同形，但每字段 readonly，start 多 startedAfterSeq: SessionSeqCursor）：
// start: { attemptId: LlmAttemptId; revision: number; turn: number; step: number }
// chunk: { attemptId: LlmAttemptId; revision: number; index: number; time: number; chunk: StreamChunk }
// end:   { attemptId: LlmAttemptId; revision: number; index: number;
//          outcome: { kind:'committed'; eventType:'assistant/message'|'assistant/attempt'; seq: number } | { kind:'abandoned' } }
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType } | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string } | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: TokenUsage } | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope };
```

**触发时机**：`start` 在 dispatch 前发；每个 `chunk` **在对应的持久化 assistant 帧落盘之后**才发（`dsh-agent-loop/README.md:119`）；`end` 有且仅有一次，`index` = 下一个 chunk 位置；`committed` = 持久化事件已提交，`abandoned` = 无法提交（尝试被放弃）。**必须按 agent 过滤**（headless 范例 `dsh-headless/lib/index.js:153-154`）：

```js
const off = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
  if (subject !== agent) return;                       // 全局事件
  if (frame.type !== 'chunk') return;
  if (frame.chunk.type === 'text-delta') process.stdout.write(frame.chunk.text);
  if (frame.chunk.type === 'reasoning-delta') process.stderr.write(frame.chunk.text);
});
```
### 5.2 持久化事实：`session/event` + `assistant/message`

`ctx.on('session/event', (session, event) => {...})`（`dsh-session/lib/index.js:1468`；官方用法 `dsh-api-session-controller/lib/index.js:1464-1471`，注意按 `session.id` 过滤）。`SessionEventMap` 相关成员（typert 清单，逐字）：

```ts
'assistant/message': { turn: number; step: number; message: AssistantMessage; stream: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true };
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] };
'turn/start': { turn: number };   'turn/end': { turn: number; reason: TurnEndReason };
'step/start': { turn: number; step: number };   'step/end': { turn: number; step: number };   'user/message': UserMessage;
'agent/inbox/spliced': { target: InboxTarget; start: number; removedCount?: number; inserted: UserMessage[]; outcome?: 'canceled' };
```

事件信封：`{ type, seq, time, data, ignorable?, surfaceOp?, sourceEventSeqs? }`（同清单；wire 版 `SessionWireEvent`）。助手**完整**回复取 `event.data.message.content` 的 `text` block（官方收集 `filter(b=>b.type==='text').map(b=>b.text).join('')`，`dsh-headless/lib/index.js:125-128`）。被中断的轮次：`assistant/message` 带 `interrupted: true`，只含已交付的可见前缀（`dsh-agent-loop/lib/index.js:1084-1100`）。`assistant/attempt` 是**不可重放**旁路帧（模型调用失败/中止时记录），**不要当作回复来源**。

### 5.3 「这一轮说完了」的信号

```ts
export interface TurnEndReasonMap {   // dsh-cordis-host-runner/lib/typert.host.js 清单
  completed: { kind: 'completed' }; aborted: { kind: 'aborted'; reason: TurnEndCancelCause };
  blocked: { kind: 'blocked' };     error: { kind: 'error'; error: LlmFailure };
  'max-tokens': { kind: 'max-tokens' }; interrupted: { kind: 'interrupted' }; forked: { kind: 'forked' };
}
```

1. **`turn/end`（最精确）**：`ctx.on('session/event', ...)` 判 `event.type === 'turn/end'`，读 `event.data.reason.kind` 与 `.turn`；写 `turn/end` 的代码在 `finally` 里，必然落盘（`dsh-agent-loop/lib/index.js:1025-1029`）。
2. **`await agent.whenIdle()`（最省事）**：等整个 agent 静默（含排队工作）。官方 headless 就是 `followup()` → `whenIdle()` → 再读 `turn/end.reason` 判成败（`dsh-headless/lib/index.js:329-345` 的 `summarize()`）。
3. **`agent/assistant-stream` 的 `end` 帧**：只代表**一次模型 attempt** 结束，**不代表整轮结束**（一轮可能多 step、多 attempt：工具调用、retry）。**不要**用它判轮次结束。
4. **`agent/status` 变 `idle`**：`ctx.on('agent/status', ({status}) => {})`。一轮结束后 `kick()` 的 `finally` 会置 idle，但**若有排队工作会立刻再 wake**，只保证「此刻无 running」（`:887-900`）。

### 5.4 中止正在跑的一轮

```js
agent.cancel({ kind: 'user' });                       // 中止当前轮 + 清空 pending inbox
agent.cancel({ kind: 'user' }, { keepInbox: true });   // 只中止当前轮，保留排队项
```

实现（`dsh-agent-loop/lib/index.js:815-821`，逐字）：

```js
cancel(cause, options = {}) {   // 同步；keepInbox 缺省即清空 pending inbox
  if (!options.keepInbox) { this.inbox.clear(); if (this.phase.kind !== "idle") this.phase.wakeRequested = false; }
  if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
}
```

- **同步**返回 `void`，只发 abort 信号；要等停稳用 `await agent.whenIdle()`。Web UI 的「停止」= `agent.cancel({ kind:'user' }, { keepInbox:true })`（`dsh-api-session-controller/lib/index.js:994-999`）。
- `cause` 闭集 `{kind:'user'}|{kind:'parent'}|{kind:'hook',reason}|{kind:'disposed'}`；`hook` 的 `reason` 进 `turn/end.reason.reason`（`dsh-agent-loop/README.md:125`）。**没有「只中止当前 step、保留 turn」的接口**（`dsh-agent/README.md:178`）。
- 已交付文本不丢：取消后把可见前缀 finalize 成 `assistant/message`（`interrupted: true`）（`:1084-1100`）。被取消的未派发工具调用补 `tool/call` + `ABORTED_BEFORE_DISPATCH` 结果对（`dsh-agent-loop/README.md:127`）。

## 6. 注册 Web HTTP 路由与鉴权

`WebServer.register`（`dsh-host-webserver/lib/index.js:177-184`，逐字）：

```js
register(route) {
  const table = route.kind === "exact" ? this.exact : this.prefixes;
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route);
  return () => { table.delete(route.path); };
}
```

`route` 形状：`{ kind: 'exact' | 'prefix', path: string, handler: async (req, res) => void }`（Node `IncomingMessage`/`ServerResponse`，**handler 自己拥有整个响应生命周期**）。升级路由 `registerUpgrade({ path, handler: (req, socket, head) => ... })`；兜底 `registerFallback(handler)`（只能一个，第二个抛）。匹配顺序：exact 全表 → 最长 prefix → fallback（`:322-332`）。handler 抛错 → 400 或销毁 socket + warning，**不退出进程**（`:246-260`）。**`dsh-host-webserver` 自身没有任何鉴权/TLS/origin 策略**（`dsh-host-webserver/README.md:113`）。

推荐入口是自带围栏与鉴权的 `ctx.connection`（`dsh-client-connection` 不在 `.archive/src`，下取自 `asar: dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`）：

```js
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/my-status', methods: ['GET', 'HEAD'],
  requestBody: 'buffered',                 // 'buffered' | 流式模式
  fetch: async (request) => new Response(JSON.stringify({ ok: true }), {
    headers: { 'cache-control': 'private, no-store', 'content-type': 'application/json' } }),
}), 'my-plugin: /api/my-status');
```

官方实例（`dsh-api-session-controller/lib/index.js:2394-2402`）：`ctx.effect(() => ctx.connection.fetch.register({ path:"/api/file", methods:["GET","HEAD"], requestBody:"buffered", fetch:(request)=>serveFile(request, ctx.fs, maxBytes) }), "...")`。rpc channel（前缀路由；路径正则 `/^\/[A-Za-z0-9._~-]+$/`，`/api` 保留）：`ctx.connection.rpc.handle('/my-channel', handler)`，内部即 `owner.effect(() => owner.webServer.register({ kind:'prefix', path, handler }))`。`assertFetchRoute` 三条拒绝规则：path 非法 / `methods` 为空 / `methods` 重复（asar 同文件 `:758-762`）。

鉴权 API 逐字（asar `.../dsh-client-connection/lib/index.js:586-602`）：

```js
requestRejection(request) {   // 先过 Host/Origin 围栏，再验浏览器会话 → 403 | 401 | undefined
  if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
  return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
admit(request) {              // → { peer } | { rejection }
  const rejection = this.requestRejection(request);
  return rejection === void 0 ? { peer: this.operator } : { rejection };
}
authorizeIndex(request, response) { return this.browserAuth.authorizeIndex(request, response); }
authenticatedUrl(baseUrl) { return this.browserAuth.authenticatedUrl(baseUrl); }
```

在自定义 `webServer` 路由里手写鉴权（这就是连接包自己注册 RPC channel 的写法，asar 同文件 `:646-654`）：

```js
const route = { kind: 'prefix', path: '/my-api', handler: async (req, res) => {
  const admission = ctx.connection.admit(req);
  if ('rejection' in admission) {                        // 401 或 403
    res.writeHead(admission.rejection);
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden'); return;
  }
  // admission.peer === ctx.connection.operator（PeerScope；operator.ctx 是连接生命周期作用域）
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
} };
```

语义要点（`asar: .../dsh-client-connection/README.md:39,43,45,47`）：`requestRejection(req)` 只读 `req.headers`（Host / Origin / `sec-fetch-site` / Cookie），**同步**；Host/Origin 检查失败 → **403**，可信但未认证 → **401**；`admit` 用 `'rejection' in admission` 判别两分支。`authenticatedUrl(baseUrl)` 给干净浏览器 URL 加**进程启动令牌** `?token=...`（唯一鉴权输入）；该 token 只在 `GET /` 被 `authorizeIndex` 接受，换取 authority 绑定的签名 cookie（`dsh-web-app` 用它打印/打开 URL）。HTTP 路由**不接受** query token（除根交换），也**不接受** Authorization 头 token。认证后的共享 HTTP 请求还会过 **`connection/request` 瀑布**：监听器可拒绝新请求，或 `await next()` 到响应结束；与 `requestRejection` 的区别是后者为同步状态码判定。Cookie 由 owner 级凭证记录 `client-connection/browser-session` 签名，`cookieMaxAgeDays` 默认 30 天。无浏览器传输的组合（headless）没有 `ctx.connection` → 必须 `inject: ['connection']`（官方范例 `dsh-api-session-controller/lib/index.js:2388-2393`）。

## 7. 插件持久化数据的推荐做法

`dsh-storage-domain/lib/index.js` 导出 `defineDomain`、`domainTable`、`DomainFacility`、`DomainError`（README `:38-58`）：

```js
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

export const mySpec = defineDomain({ name: 'my-plugin', version: 1,   // 只声明一次并导出
  tables: { bindings: domainTable(z.object({ chatId: z.string(), sessionId: z.string() })) } });

const domain = await ctx.storageDomain.open(mySpec);   // 读=同步内存读；写 resolve 前已持久化
await domain.table('bindings').put(id, { chatId, sessionId });
const rec = domain.table('bindings').get(id);          // 同步
domain.table('bindings').update(id, (r) => ({ ...r, chatId: 'x' }));
domain.close();                                        // 通常放自己的 ctx.effect disposer
```

- 每次写入在 backend 确认持久化后才 resolve，并按序 emit 一次 `domain/changed`（README `:49,:73`）；失败码：`already-open` / `facet-unsupported` / `invalid-record` / `missing-key` / `closed`（README `:73`）。
- 必须先挂 `@deepseek-ai/dsh-storage-domain` 并配置 `backend`；未挂时 `ctx.storageDomain === undefined`，用 `ctx.inject(['storageDomain'], (c) => {...})` 包一层。不适用：会话日志数据（归 `sessionPersistence`）、跨表事务、二级索引（README `:152`）。
- **直接写 `DSH_HOME` 文件**也是官方做法（JSONL 后端即 `root: z.string().required()` + `this.root = resolve(config.root)`，asar `.../dsh-session-persistence-jsonl/lib/index.js:2374-2400`）：

```js
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh');   // DSH_HOME 下自建子目录
const dir = join(home, 'my-plugin');
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'state.json'), JSON.stringify(state), 'utf8');
```

  这条**非托管**：无 schema 校验、无变更事件、无单写者互斥；要并发安全用 `storageDomain` 或自建文件锁。`ctx.settings`（`dsh-settings`）是**配置表单**服务，只暴露插件的 `.volatile()` 配置字段并写回 profile 的 Cordis patch，**不是**通用 KV，不适合放自有业务数据（`dsh-settings/README.md:33,47-49`）。

## 8. 注册自定义 Tool 与人类命令

`ToolRegistry.register` 的必填校验（`dsh-tools/lib/types/index.js:459-480`，逐字）：

```js
register(definition) {   // dsh-tools/lib/types/index.js:459-480 逐字（空白略作压缩）
  const name = definition.name, output = definition.output;
  if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`); }
  assertSupportedJsonSchema(output.schema);
  const timeoutMs = definition.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  if (name === RUN_CODE_NAME) throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
  return this.layers.effect(this.ctx, layer => layer.tools.insert(name, definition), { label: 'tools.register()' });
}
```

最小可用形状（照抄官方 `plugin_manager` 工具，`dsh-plugin-manager/lib/types/tools.js:11-30`）：

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

ctx.tools.register(defineTool({
  name: 'my_tool',                     // 必填；不能是保留名 run_code
  description: '……给模型看的说明……',     // 必填
  parameters: {                         // 必填；dsh ParameterSchemaSpec 语法
    text: { type: 'string', required: true, description: '输入文本' },
    count: { type: 'number', description: '可选数量' } },
  output: {                             // 必填
    schema: { type: 'string' },         // 受支持的 JSON Schema
    render: (_args, value) => [{ type: 'text', text: value }] },   // 必填函数
  async execute(args, exec) {           // exec: { agent, callId, signal, ... }
    exec.signal.throwIfAborted();
    return '结果字符串'; },
  // 可选：timeoutMs（正有限数）、presentCall(args)
}));
```

- `ToolSchema`（wire 形状）：`{ name, description, parameters: Record<string, unknown>, deferLoading?: true }`（typert 清单）。作用域：`ctx.tools.register` 全局；`agentCtx.tools.register` 仅该 agent 且**遮蔽**全局同名（`:453-455`）。
- 收窄 agent 可用工具：`agentCtx.tools.restrict({ allow: [...], deny: [...] })`，必须在 scoped ctx 上调；空 filter/未知名抛错（`:488-511`）；执行前守卫：`ctx.tools.registerGuard(...)`（在 `tools/pre-execute` 瀑布之后，`:513-519`）。

人类斜杠命令 `ctx.commands.register`（不进模型消息；`asar: .../dsh-commands/README.md:34-44` + 校验 `asar: .../dsh-commands/lib/types/index.js:125-162`）：

```js
ctx.commands.register({
  name: 'plan',                          // 必须匹配 COMMAND_NAME（小写字母/数字/_/-）
  description: 'Enter plan mode',        // 非空字符串
  input: { hint: '<message>', attachments: false },   // 可选；hint 必填非空
  recordInput: true,                      // 可选，默认 true；自带域事件时设 false
  handler: ({ agent, rawInput }) => ({ kind: 'success', text: 'plan mode selected' }),   // 必须是函数
});
```

`handler` 入参 = invocation（含 `agent`、`rawInput`、`attachments`）；返回值必须是 `{ kind:'success', text?, sourceEventSeq? }` 或 `{ kind:'error', text }`（非空文本）（asar 同文件 `:172-194`）。每次成功分发在目标 agent 的 session 写 `command/run` + `command/done`（README `:89`）。同名重复注册抛错；agent 作用域注册遮蔽全局同名（README `:46,54`）。需要 `inject: ['commands']`（服务由 `@deepseek-ai/dsh-commands` 提供，`super(ctx,'commands')`，asar `lib/index.js:259`）。

## 9. `dsh-plugin-manager` 对插件包的硬性要求

### 9.1 必须是 ESM；`dsh.bundle.patch` 是 bundle 的唯一声明

官方每个包都写死 `"type": "module"` + `"main": "lib/index.js"` + `"exports"`（见 `dsh-agent/package.json`、`dsh-agent-loop/package.json`、`dsh-host-webserver/package.json`）。DSH 内部一律 `import`，**没有 CJS 入口回退**。

```json
{ "name": "@acme/dsh-my-plugin", "version": "1.0.0", "type": "module", "main": "lib/index.js",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

- 解析：`bundlePatchFiles(bundle)` —— `patch` 可以是**单字符串**或**字符串数组**（按序应用），其它类型抛 `Error`（`asar: dsh-app-boot/lib/index.js:495-508`）。
- **`dsh.bundle` 不是必须，但没有它就不是 bundle**：安装时只提示 `` dsh: warning: <name> declares no dsh.bundle — installed as a plain dependency, not a profile layer ``（`dsh-plugin-manager/lib/index.js:251`），且 `setBundleEnabled`/`installBundle` 被拒 `` refused("not-a-bundle", `<name> declares no dsh.bundle`) ``（`:1587`、`:1638`）。
- patch 行形状：`{ id, name, inject?, disabled?, config? }`，或 `{ insert: [...] }`、`{ id, config: {...} }` 覆盖已有行（范例：`dsh-headless/cordis.patch.yml`、`dsh-sdk-app/cordis.patch.yml`）。
- Host half 本体 = patch 里 `insert` 那一行 `name` 指向的包，必须是 Cordis 插件：`export const name`、`export const inject?`、`export const Config?`（schemastery）、`export function apply(ctx, config)`（范例 `dsh-headless/lib/index.js:98-110,355-366`）。

### 9.2 peerDependencies 与版本兼容校验

安装前逐包判定（`asar: dsh-app-boot/lib/index.js:286-313`）：

```js
function evaluatePluginCompatibility(manifest, exemptions = {}, runtimeVersion = getDshRuntimeVersion()) {
  // 只检查 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* 前缀的 peer
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  // workspace:^ / workspace:~ / workspace:* 视为「当前 runtime 版本」；其余交给
  // semver.satisfies(runtimeVersion, range, { includePrerelease: true })
  // 不合格 → 返回 { name, version, runtimeVersion, peers, exempted }
}
```

- 判定**只覆盖 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 peer**，其它 peer 交给 pnpm。预发布参与范围匹配（`includePrerelease:true`），所以 `0.2.0-rc.2` 对 `~0.2.0-rc.2` 通过。
- 不兼容则**在 pnpm 跑之前**拒绝（registry/path 规格），报 `incompatible-version` 并附 `{name, version, runtimeVersion, peers}`（`dsh-plugin-manager/lib/index.js:1491,1756,1788,1987`；README `:63,:69`）。git/tarball 规格安装后才判定，失败会回滚 `package.json` + `pnpm-lock.yaml`。
- **豁免**：profile 目录下 `compatibility.json`，键 = 精确 `package-name@version`，值 = 精确 DSH runtime 版本数组（`PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`，asar `dsh-app-boot/lib/index.js:328`；README `:65`）。授予需 `acceptRisk: true`，**必须先告知用户可能崩溃/丢数据**；豁免不继承、不授权构建脚本。

### 9.3 安装时校验/拒绝什么（速查）

| 阶段 | 校验 | 拒绝结果 |
| --- | --- | --- |
| `inspect(spec)` | registry `pnpm view` / 本地读 `package.json` | `problem`: `invalid-spec`/`already-installed`/`not-found`/`not-a-package`/`not-a-bundle`/`network`/`unknown`（README `:46`） |
| 安装前 | 命名包的 DSH peer 兼容判定 | `incompatible-version` + `incompatible[]`（README `:63`） |
| 安装中 | pnpm 11 阻止依赖脚本 | `pendingBuilds[]`，需 `approvedBuilds` 显式批准（README `:58`） |
| 安装后 | bundle 声明 + patch 可加载 | 无 `dsh.bundle` → 只当普通依赖、不能 enable；加载不了则留在 `listBundles` 带 `error`（README `:42,:44`） |
| 启用 | patch 行 `disabled` 写入 | 行/模块断言不匹配即失败（README `:40`） |

安装失败恢复 `package.json` 与 `pnpm-lock.yaml`（**不**恢复 `pnpm-workspace.yaml`）；移除顺序「从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → `pnpm remove`」（README `:144-150`）。第三方包名**没有**额外前缀要求，官方各包用 `"publishConfig": { "access": "public" }`。

## 10. 未确认 / 明确不存在

- **`sessionLogDeepseek`**：`.archive/src` + app.asar 全量搜索无此服务名。**未确认，勿用**；持久化服务名是 `ctx.sessionPersistence`。
- **`session.prompt(...)`**：`Session` 类没有 `prompt`（§3.1 是其完整公开面）。`prompt` 只在 Remote 层的 `SessionController`；插件里的等价调用是 `agent.followup()/steer()`。
- **`inbox.push(...)`**：不存在。Inbox API 是 `append/prepend/replace/remove/clear/splice`；语义化投递用 `agent.followup/steer/inject`。
- **`ctx.agentLoop.createAgent(ownerCtx, opts)` 可调用但不是公开面**：`AgentLoop` 确实占 `ctx.agentLoop`（`dsh-agent-loop/lib/index.js:1552`），`createAgent(ownerCtx, options)` 也确实存在（`:1851`），但官方要求消费 `ctx.agents`（`dsh-agent-loop/README.md:89`）。只在需要「agent 随我的插件卸载而销毁」时用它，并把 `ownerCtx` 传成自己的 `ctx`。
- **`ctx.connection` 的完整 Client 侧 API**：本文只覆盖 Host 侧 `admit / requestRejection / authorizeIndex / authenticatedUrl / fetch.register / rpc.handle`。连接代际与重连策略属 Client 层。
- **`route` 的 TypeScript 类型名**（如 `HttpRoute`）与 **`AgentHandle` 的完整声明文本**在本归档中**未确认**（typert 清单未收录这两个名字）；已确证的是 `{ kind, path, handler }` 用法、`handle.agent`（`Agent`）与 `await handle.dispose()`。
