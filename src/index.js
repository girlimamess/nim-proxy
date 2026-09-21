const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

// Model order:
// 1. Kimi K3 — your current working model
// 2. GLM-5.3 Flash — newer fallback
// 3. GLM-5.3 — larger fallback
// 4. Nemotron 3 Super — long-context fallback
// 5. Gemma 4 31B — additional fallback
const MODELS = [
  "moonshotai/kimi-k3",
  "z-ai/glm-5-3-flash",
  "z-ai/glm-5-3",
  "nvidia/nemotron-3-super-120b-a12b",
  "google/gemma-4-31b-it"
];

const TIMEOUT_MS = 30000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Model-Used",
  };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

async function callNVIDIA(env, body, model) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const requestBody = {
      ...body,
      model,
      stream: true,
    };

    // GLM's NVIDIA endpoint supports reasoning separately from the
    // visible answer. Clear thinking keeps reasoning out of the RP text.
    if (model === "z-ai/glm-5-3" || model === "z-ai/glm-5-3-flash") {
      requestBody.chat_template_kwargs = {
        clear_thinking: true,
      };
    }

    const response = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NIM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();

      return {
        ok: false,
        status: response.status,
        error: errorText.slice(0, 2000),
      };
    }

    if (!response.body) {
      return {
        ok: false,
        status: 502,
        error: "NVIDIA returned no response body",
      };
    }

    return {
      ok: true,
      response,
    };
  } catch (error) {
    clearTimeout(timeout);

    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 502,
      error: error?.message || String(error),
    };
  }
}

function cleanSSEStream(readable) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = "";

  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const line of parts) {
          if (!line.startsWith("data: ")) {
            controller.enqueue(encoder.encode(line + "\n"));
            continue;
          }

          const payload = line.slice(6);

          if (payload === "[DONE]") {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            const json = JSON.parse(payload);

            if (json.choices) {
              for (const choice of json.choices) {
                if (choice.delta) {
                  // Prevent hidden reasoning from leaking into JanitorAI.
                  delete choice.delta.reasoning_content;
                  delete choice.delta.reasoning;
                }
              }
            }

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(json)}\n\n`)
            );
          } catch {
            // Preserve malformed/unexpected SSE lines rather than crashing.
            controller.enqueue(encoder.encode(line + "\n"));
          }
        }
      },

      flush(controller) {
        if (buffer) {
          controller.enqueue(encoder.encode(buffer + "\n"));
        }
      },
    })
  );
}

async function handleChat(request, env) {
  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: {
          message: "Invalid JSON request body",
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonResponse(
      {
        error: {
          message: "Missing messages array",
          type: "invalid_request_error",
        },
      },
      400
    );
  }

  // Don't let JanitorAI's model name force an unavailable/deprecated model.
  // The Worker controls the actual NVIDIA model used.
  const originalModel = body.model;

  // Reasonable defaults for RP.
  const upstreamBody = {
    messages: body.messages,
    temperature:
      typeof body.temperature === "number"
        ? body.temperature
        : 0.85,
    top_p:
      typeof body.top_p === "number"
        ? body.top_p
        : 0.95,
    max_tokens:
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : 2048,
    stream: true,
  };

  // Preserve other OpenAI-compatible parameters JanitorAI may send.
  const optionalFields = [
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "seed",
    "response_format",
  ];

  for (const field of optionalFields) {
    if (body[field] !== undefined) {
      upstreamBody[field] = body[field];
    }
  }

  const failures = [];

  for (const model of MODELS) {
    const result = await callNVIDIA(env, upstreamBody, model);

    if (result.ok) {
      const headers = {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Model-Used": model,
      };

      return new Response(
        cleanSSEStream(result.response.body),
        {
          status: 200,
          headers,
        }
      );
    }

    failures.push({
      model,
      status: result.status,
      error: result.error,
    });
  }

  return jsonResponse(
    {
      error: {
        message: "All NVIDIA models failed",
        type: "upstream_error",
        requested_model: originalModel || null,
        attempts: failures,
      },
    },
    502
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "nim-proxy",
        models: MODELS,
      });
    }

    // Show currently configured models
    if (url.pathname === "/models") {
      return jsonResponse({
        models: MODELS,
        timeout_ms: TIMEOUT_MS,
      });
    }

    // NVIDIA/OpenAI-compatible endpoint
    if (
      url.pathname === "/v1/chat/completions" &&
      request.method === "POST"
    ) {
      return handleChat(request, env);
    }

    return jsonResponse({
      ok: true,
      message: "NVIDIA NIM proxy is running",
      endpoints: [
        "/health",
        "/models",
        "/v1/chat/completions",
      ],
    });
  },
};
