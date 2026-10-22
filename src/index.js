
const NVIDIA_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

const MODELS = [
  "deepseek-ai/deepseek-v4.1-flash",
  "nvidia/nemotron-3-super-120b-a12b",
  "google/gemma-4-31b-it",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "openai/gpt-oss-20b",
  "stepfun-ai/step-5-preview"
];

const TIMEOUT_MS = 25000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Model-Used"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

async function callNVIDIA(env, body, model) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  try {
    const response = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.NIM_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream"
      },
      body: JSON.stringify({
        ...body,
        model,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      let errorText = "";

      try {
        errorText = await response.text();
      } catch {
        errorText = "Could not read NVIDIA error response";
      }

      clearTimeout(timeout);

      return {
        ok: false,
        status: response.status,
        error: errorText.slice(0, 1500)
      };
    }

    if (!response.body) {
      clearTimeout(timeout);

      return {
        ok: false,
        status: 502,
        error: "NVIDIA returned no response body"
      };
    }

    // Keep the abort signal active while the response stream is consumed.
    // The caller clears it when the stream finishes or is cancelled.
    return {
      ok: true,
      response,
      controller,
      timeout
    };
  } catch (error) {
    clearTimeout(timeout);

    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 502,
      error: error?.message || String(error)
    };
  }
}

function cleanSSEStream(readable, controller, timeout) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const cleanup = () => clearTimeout(timeout);

  return readable.pipeThrough(
    new TransformStream({
      transform(chunk, streamController) {
        buffer += decoder.decode(chunk, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (let line of lines) {
          line = line.replace(/\r$/, "");

          if (!line.startsWith("data: ")) {
            streamController.enqueue(encoder.encode(line + "\n"));
            continue;
          }

          const payload = line.slice(6);

          if (payload === "[DONE]") {
            streamController.enqueue(
              encoder.encode("data: [DONE]\n\n")
            );
            continue;
          }

          try {
            const data = JSON.parse(payload);

            if (Array.isArray(data.choices)) {
              for (const choice of data.choices) {
                if (choice.delta) {
                  delete choice.delta.reasoning_content;
                  delete choice.delta.reasoning;
                }

                if (choice.message) {
                  delete choice.message.reasoning_content;
                  delete choice.message.reasoning;
                }
              }
            }

            streamController.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            streamController.enqueue(
              encoder.encode(line + "\n")
            );
          }
        }
      },

      flush(streamController) {
        buffer += decoder.decode();

        if (buffer) {
          streamController.enqueue(
            encoder.encode(buffer + "\n")
          );
        }

        cleanup();
      }
    })
  ).pipeThrough(
    new TransformStream({
      transform(chunk, streamController) {
        streamController.enqueue(chunk);
      },
      flush() {
        cleanup();
      }
    })
  );
}

async function handleChat(request, env) {
  if (!env.NIM_API_KEY) {
    return jsonResponse({
      error: {
        message: "NIM_API_KEY Worker secret is missing",
        type: "configuration_error"
      }
    }, 500);
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({
      error: {
        message: "Invalid JSON request body",
        type: "invalid_request_error"
      }
    }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse({
      error: {
        message: "Missing or empty messages array",
        type: "invalid_request_error"
      }
    }, 400);
  }

  const upstreamBody = {
    messages: body.messages,
    temperature:
      typeof body.temperature === "number" ? body.temperature : 0.9,
    top_p:
      typeof body.top_p === "number" ? body.top_p : 0.95,
    max_tokens:
      typeof body.max_tokens === "number" ? body.max_tokens : 2048,
    stream: true
  };

  const optionalFields = [
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "seed",
    "response_format"
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
      const stream = cleanSSEStream(
        result.response.body,
        result.controller,
        result.timeout
      );

      return new Response(stream, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Model-Used": model
        }
      });
    }

    failures.push({
      model,
      status: result.status,
      error: result.error
    });
  }

  return jsonResponse({
    error: {
      message: "All configured NVIDIA models failed",
      type: "upstream_error",
      attempts: failures
    }
  }, 502);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        worker: "nim-proxy",
        primary: MODELS[0],
        models: MODELS
      });
    }

    if (url.pathname === "/models") {
      return jsonResponse({
        models: MODELS,
        timeout_ms: TIMEOUT_MS
      });
    }

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
        "/v1/chat/completions"
      ]
    });
  }
};
