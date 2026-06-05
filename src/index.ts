// ============================================================
// OpenCode Anthropic Proxy — Cloudflare Workers
// 将 OpenCode Go 套餐的 DeepSeek V4 Flash API
// 反向代理为 Anthropic Messages API 格式
// ============================================================

// ---- 类型定义 ----

interface Env {
  OPENCODE_BASE_URL?: string;
  TARGET_MODEL?: string;
  ALLOWED_MODELS?: string;
  ANTHROPIC_VERSION?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | { type: "text"; text: string }[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: Record<string, string>;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
}

interface OpenAIChoice {
  index: number;
  message: { role: string; content: string; reasoning_content?: string };
  finish_reason: string | null;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string; reasoning_content?: string };
    finish_reason: string | null;
  }[];
  usage?: OpenAIUsage;
}

// ---- 常量 ----

const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_TARGET_MODEL = "deepseek-v4-flash";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta",
  "Access-Control-Max-Age": "86400",
};

// ---- 工具函数 ----

function uuid(): string {
  return crypto.randomUUID();
}

// ---- 请求解析 ----

function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (b): b is ContentBlock & { text: string } =>
        b.type === "text" && !!b.text,
    )
    .map((b) => b.text)
    .join("\n");
}

function extractSystemPrompt(
  system: string | { type: "text"; text: string }[] | undefined,
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((b) => b.text).join("\n");
}

// ---- 格式转换：Anthropic → OpenAI ----

function convertAnthropicToOpenAI(
  body: AnthropicRequest,
  targetModel: string,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // system prompt → system message
  const systemText = extractSystemPrompt(body.system);
  if (systemText) {
    messages.push({ role: "system", content: systemText });
  }

  // user/assistant messages
  for (const msg of body.messages) {
    messages.push({
      role: msg.role as "user" | "assistant",
      content: extractTextFromContent(msg.content),
    });
  }

  return {
    model: targetModel,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: body.stream ?? false,
  };
}

// ---- 格式转换：OpenAI → Anthropic（非流式） ----

function buildContent(msg: {
  content?: string;
  reasoning_content?: string;
}): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  if (msg.reasoning_content) {
    blocks.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  blocks.push({ type: "text", text: msg.content || "" });
  return blocks;
}

function convertOpenAIToAnthropic(
  oaiResp: OpenAIResponse,
  requestModel: string,
): AnthropicResponse {
  const choice = oaiResp.choices?.[0];
  const stopReason =
    choice?.finish_reason === "stop"
      ? "end_turn"
      : choice?.finish_reason === "length"
        ? "max_tokens"
        : (choice?.finish_reason ?? null);

  return {
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: buildContent(choice?.message ?? {}),
    model: requestModel,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens ?? 0,
      output_tokens: oaiResp.usage?.completion_tokens ?? 0,
    },
  };
}

// ---- 流式转换（OpenAI SSE → Anthropic SSE） ----

type StreamState = "idle" | "thinking" | "text";

function createAnthropicStream(
  openaiStream: ReadableStream<Uint8Array>,
  requestModel: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let state: StreamState = "idle";
  let sentMessageStart = false;
  let pendingUsage: OpenAIUsage | null = null;
  const blockIds = { thinking: 0, text: 1 };

  function send(controller: ReadableStreamDefaultController, obj: unknown) {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  }

  function sendMessageStart(
    controller: ReadableStreamDefaultController,
    model: string,
  ) {
    if (sentMessageStart) return;
    send(controller, {
      type: "message_start",
      message: {
        id: `msg_${uuid()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: pendingUsage?.prompt_tokens ?? 0,
          output_tokens: 0,
        },
      },
    });
    sentMessageStart = true;
  }

  function ensureInBlock(
    controller: ReadableStreamDefaultController,
    target: "thinking" | "text",
  ) {
    if (state === target) return;
    // 关闭当前 block
    if (state === "thinking") {
      send(controller, {
        type: "content_block_stop",
        index: blockIds.thinking,
      });
    } else if (state === "text") {
      send(controller, { type: "content_block_stop", index: blockIds.text });
    }
    // 开启新 block
    state = target;
    send(controller, {
      type: "content_block_start",
      index: blockIds[target],
      content_block:
        target === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "text", text: "" },
    });
  }

  function closeAllBlocks(controller: ReadableStreamDefaultController) {
    if (state === "thinking") {
      send(controller, {
        type: "content_block_stop",
        index: blockIds.thinking,
      });
    } else if (state === "text") {
      send(controller, { type: "content_block_stop", index: blockIds.text });
    }
    state = "idle";
  }

  function sendFinishEvents(
    controller: ReadableStreamDefaultController,
    finishReason: string,
  ) {
    const stopReason =
      finishReason === "stop"
        ? "end_turn"
        : finishReason === "length"
          ? "max_tokens"
          : finishReason;

    send(controller, {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: pendingUsage?.completion_tokens ?? 0 },
    });
    send(controller, { type: "message_stop" });
  }

  return new ReadableStream({
    async start(controller) {
      const reader = openaiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFinished = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;

            const data = trimmed.slice(6).trim();
            if (data === "[DONE]") continue;

            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }

            const delta = chunk.choices?.[0]?.delta;
            const finishReason = chunk.choices?.[0]?.finish_reason;
            const reasoning = delta?.reasoning_content;
            const content = delta?.content;

            // 保存 usage
            if (chunk.usage) {
              pendingUsage = chunk.usage;
            }

            // 确保已发送 message_start
            if (!sentMessageStart) {
              sendMessageStart(controller, requestModel);
            }

            // --- reasoning → thinking block ---
            if (reasoning) {
              ensureInBlock(controller, "thinking");
              send(controller, {
                type: "content_block_delta",
                index: blockIds.thinking,
                delta: { type: "thinking_delta", thinking: reasoning },
              });
            }

            // --- content → text block ---
            if (content) {
              ensureInBlock(controller, "text");
              send(controller, {
                type: "content_block_delta",
                index: blockIds.text,
                delta: { type: "text_delta", text: content },
              });
            }

            // --- finish ---
            if (finishReason) {
              closeAllBlocks(controller);
              sendFinishEvents(controller, finishReason);
              streamFinished = true;
            }
          }
        }

        // 处理缓冲区剩余内容
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6).trim();
            if (data !== "[DONE]") {
              try {
                const chunk = JSON.parse(data);
                const delta = chunk.choices?.[0]?.delta;
                const reasoning = delta?.reasoning_content;
                const content = delta?.content;

                if (!sentMessageStart) {
                  sendMessageStart(controller, requestModel);
                }
                if (reasoning) {
                  ensureInBlock(controller, "thinking");
                  send(controller, {
                    type: "content_block_delta",
                    index: blockIds.thinking,
                    delta: { type: "thinking_delta", thinking: reasoning },
                  });
                }
                if (content) {
                  ensureInBlock(controller, "text");
                  send(controller, {
                    type: "content_block_delta",
                    index: blockIds.text,
                    delta: { type: "text_delta", text: content },
                  });
                }
              } catch {
                // ignore
              }
            }
          }
        }

        // 流结束但未收到 finish_reason
        if (!streamFinished) {
          if (!sentMessageStart) {
            sendMessageStart(controller, requestModel);
          }
          // 至少发一个空的 text block
          if (state === "idle") {
            send(controller, {
              type: "content_block_start",
              index: blockIds.text,
              content_block: { type: "text", text: "" },
            });
            send(controller, {
              type: "content_block_stop",
              index: blockIds.text,
            });
          } else {
            closeAllBlocks(controller);
          }
          sendFinishEvents(controller, "end_turn");
        }

        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

// ---- 请求处理 ----

function corsResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return corsResponse(
    { type: "error", error: { type: "invalid_request_error", message } },
    status,
  );
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

// ---- 健康检查 ----

function handleHealth(): Response {
  return corsResponse({ status: "ok", service: "opencode-anthropic-proxy" });
}

// ---- /v1/models ----

function handleModels(env: Env): Response {
  const targetModel = env.TARGET_MODEL || DEFAULT_TARGET_MODEL;
  const allowedModels = env.ALLOWED_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const models =
    allowedModels && allowedModels.length > 0 ? allowedModels : [targetModel];

  return corsResponse({
    data: models.map((id) => ({
      type: "model",
      id,
      display_name: id,
      created_at: "2025-01-01T00:00:00Z",
    })),
  });
}

// ---- /v1/messages ----

async function handleMessages(request: Request, env: Env): Promise<Response> {
  // 1. 解析请求体
  let body: AnthropicRequest;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  // 2. 验证必填字段
  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return errorResponse("messages is required and must be a non-empty array");
  }
  if (!body.max_tokens || body.max_tokens < 1) {
    return errorResponse(
      "max_tokens is required and must be a positive integer",
    );
  }

  // 3. 验证模型（可选）
  const allowedModels = env.ALLOWED_MODELS?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (allowedModels && allowedModels.length > 0) {
    if (!allowedModels.includes(body.model)) {
      return errorResponse(
        `model "${body.model}" is not allowed. Allowed models: ${allowedModels.join(", ")}`,
        403,
      );
    }
  }

  // 4. 配置
  const opencodeBaseUrl = (
    env.OPENCODE_BASE_URL || DEFAULT_OPENCODE_BASE_URL
  ).replace(/\/+$/, "");
  const targetModel = env.TARGET_MODEL || DEFAULT_TARGET_MODEL;
  const requestModel = body.model;

  // 5. 从请求头提取 API Key（透传模式）
  const authHeader = request.headers.get("Authorization") || "";
  const apiKeyHeader = request.headers.get("x-api-key") || "";
  const opencodeApiKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : apiKeyHeader;
  if (!opencodeApiKey) {
    return errorResponse(
      "Missing API key. Provide x-api-key or Authorization: Bearer header",
      401,
    );
  }

  // 6. 转换为 OpenAI 格式
  const openaiReq = convertAnthropicToOpenAI(body, targetModel);

  const controller = new AbortController();
  // 设置超时（5 分钟）
  const timeout = setTimeout(() => controller.abort(), 300_000);

  try {
    const opencodeResp = await fetch(`${opencodeBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opencodeApiKey}`,
      },
      body: JSON.stringify(openaiReq),
      signal: controller.signal,
    });

    if (!opencodeResp.ok) {
      const errorText = await opencodeResp.text();
      return corsResponse(
        {
          type: "error",
          error: {
            type: "upstream_error",
            message: `OpenCode API error (${opencodeResp.status})`,
            upstream_error: errorText,
          },
        },
        opencodeResp.status,
      );
    }

    // 7. 处理流式响应
    if (body.stream) {
      const contentType = opencodeResp.headers.get("content-type") || "";
      const isStreaming =
        contentType.includes("text/event-stream") || body.stream;

      if (isStreaming && opencodeResp.body) {
        const anthropicStream = createAnthropicStream(
          opencodeResp.body,
          requestModel,
        );

        return new Response(anthropicStream, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "x-request-id": `req_${uuid()}`,
          },
        });
      }
    }

    // 8. 非流式响应
    const oaiData: OpenAIResponse = await opencodeResp.json();
    const anthropicResp = convertOpenAIToAnthropic(oaiData, requestModel);

    return new Response(JSON.stringify(anthropicResp), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "x-request-id": `req_${uuid()}`,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return errorResponse("Upstream request timed out", 504);
    }
    return errorResponse(
      `Upstream request failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Worker 入口 ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    // 路由
    switch (true) {
      case request.method === "GET" && url.pathname === "/health":
        return handleHealth();

      case request.method === "GET" && url.pathname === "/v1/models":
        return handleModels(env);

      case request.method === "POST" && url.pathname === "/v1/messages":
        return handleMessages(request, env);

      default:
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "not_found",
              message: `Not found: ${request.method} ${url.pathname}`,
            },
          }),
          {
            status: 404,
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
    }
  },
};
