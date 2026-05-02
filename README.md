# Claude Key Tester

一个简易网页：输入 `baseUrl`、`apiKey`、测试文案（可选 model），按 Claude Messages API 方式发消息，判断 key 是否可用。

默认配置：

- `baseUrl`: `https://anyrouter.top`
- `model`: `claude-opus-4-7`
- 默认启用 1m 上下文 + Claude Code 指纹（带 `?beta=true`、完整 4 个 beta、stream、thinking、output_config、伪造 metadata.user_id）

## 启动

```bash
cd /root/docker-project/claude-key-tester
docker compose up -d --build
```

打开：`http://<你的服务器IP>:18080`

---

## anyrouter / new-api 中转的踩坑笔记

如果你也在自建客户端去访问 anyrouter 这类基于 [Calcium-Ion/new-api](https://github.com/Calcium-Ion/new-api) 的中转，下面这些是排坑得到的结论。

### 死循环：上游强制 1m beta，但 1m 处理器空指针 panic

- 不带 `anthropic-beta` → `400 "1m 上下文已经全量可用，请启用 1m 上下文后重试"`
- 带 `anthropic-beta: context-1m-2025-08-07` → `500 "Panic detected, runtime error: invalid memory address or nil pointer dereference"`

两条路都堵死。`/v1/models` GET 是 200（key 有效），所以不是 key 的问题。

### 触发 panic 的真凶：缺 `thinking` 字段

new-api 在处理 1m beta 时会去解引用 `req.Thinking.Type`。请求体里缺这个字段就空指针 panic。

```jsonc
// 加上这两个字段后,panic 消失
"thinking": { "type": "adaptive" },
"output_config": { "effort": "xhigh" }
```

### 然而光修 panic 还不够：anyrouter 在做"客户端指纹检查"

补完 `thinking` 后请求会变成 `503 "Service Unavailable"`。原因是 anyrouter 校验请求形状是否像真正的 Claude Code 客户端，不像就直接拒。**所有这些字段缺一不可**：

| 位置 | 必需值 | 缺了会怎样 |
|---|---|---|
| URL | `?beta=true` 查询参数 | 503 |
| Header `Authorization` | `Bearer <key>` | （`x-api-key` 也能过认证，但走 `Authorization` 更稳）|
| Header `anthropic-beta` | 完整 4 个：`claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24` | 503 |
| Header `anthropic-dangerous-direct-browser-access` | `true` | 503 |
| Header `x-app` | `cli` | 503 |
| Header `User-Agent` | `claude-cli/2.1.118 (external, cli)` | 503 |
| Body `stream` | `true` | 503 |
| Body `thinking` | `{ "type": "adaptive" }` | **500 panic** |
| Body `output_config` | `{ "effort": "xhigh" }` | 503 |
| Body `metadata.user_id` | **必须是内嵌 JSON 字符串**，包含 `device_id`、`account_uuid`、`session_id` 三个字段 | 503 |
| Body `system` | 数组形式 + `cache_control: { "type": "ephemeral" }` | 503 |
| Body `messages[].content` | 数组形式 + `cache_control: { "type": "ephemeral" }` | 503 |

### `metadata.user_id` 的格式特别坑

它在 JSON 里是一个**字符串字段**，但内容必须再是一段 JSON：

```json
{
  "metadata": {
    "user_id": "{\"device_id\":\"a116e83f...\",\"account_uuid\":\"\",\"session_id\":\"07b7506a-...\"}"
  }
}
```

- `"user_id": "claude-key-tester"` → 503
- `"user_id": "{\"device_id\":\"<任意 64 位 hex>\",\"account_uuid\":\"\",\"session_id\":\"<任意 uuid>\"}"` → 200

值是什么不重要（device_id 全填 'a' 也行），格式必须对。anyrouter 只是 `JSON.parse(user_id)` 检查里面有没有这三个 key。

### 认证生效的地方

- `Authorization: Bearer sk-xxx` ✅
- `x-api-key: sk-xxx` ✅（也能过）
- 错误 key → `400 "无效的令牌"`（区分明确，方便检测）

### 别浪费时间试的路径

| 路径 | 结果 |
|---|---|
| `/v1/messages` | 真正的 API（panic 或 503/200）|
| `/anthropic/v1/messages` | 返回前端 SPA HTML |
| `/api/v1/messages`、`/claude/v1/messages`、`/proxy/v1/messages`、`/relay/v1/messages` | 阿里云 ESA WAF 反爬 JS 挑战 |
| `/v1/chat/completions` | 404 "当前 API 不支持所选模型"（不支持 OpenAI 格式）|
| 子域 `pool/api/ai/claude.anyrouter.top` | 不存在（TLS 失败）|

### 模型名

`/v1/models` 返回的合法 ID 列表（截至最近一次抓取）：

```
claude-3-5-haiku-20241022
claude-3-5-sonnet-20241022
claude-opus-4-1-20250805
claude-opus-4-20250514
claude-opus-4-5-20251101
claude-opus-4-6
claude-opus-4-7
claude-sonnet-4-5
claude-sonnet-4-6
claude-haiku-4-5
...
```

注意全部用**横线**（`claude-opus-4-7`），不是点号（`claude-opus-4.7`）。点号会被 new-api 解析失败，退回到上面那个 panic 死循环。

### 流式响应

`stream: true` 是必需的（去掉变 503）。响应是 SSE：

```
event: message_start
data: {...}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}

event: message_stop
data: {...}
```

要拿到回复文本，遍历 `data:` 行，挑 `type === "content_block_delta"` 的 `delta.text` 拼起来即可。

---

## 本工具的请求构造

`server.js:callMessages()` 在 `enable1m: true` 时按上面的清单组装：

```js
{
  url: `${baseUrl}/v1/messages?beta=true`,
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,effort-2025-11-24',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-app': 'cli',
    'User-Agent': 'claude-cli/2.1.118 (external, cli)',
  },
  body: {
    model: 'claude-opus-4-7',
    max_tokens: 256,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    metadata: {
      user_id: JSON.stringify({
        device_id: 'a'.repeat(64),
        account_uuid: '',
        session_id: '00000000-0000-0000-0000-000000000000',
      }),
    },
    system: [
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<prompt>', cache_control: { type: 'ephemeral' } }] },
    ],
  }
}
```

返回判定：

- `200` + SSE → `success: true, canUseKey: true`，解析出 reply 文本
- `502/503/504` → `canUseKey: true, upstreamBusy: true`（认证已穿透，上游临时不可用）
- 其它（401/400 invalid key 等）→ `canUseKey: false`

### 模型回退链

如果第一次调用因为模型名问题失败（400/404/422，错误信息含 model 关键字），自动 `GET /v1/models` 取第一个 ID 重试一次。
