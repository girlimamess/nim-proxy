var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", {
    value,
    configurable: true
  });

// src/index.js

var MODEL_MAP = {
  "llama-70b": "deepseek-ai/deepseek-v4-flash-0731",
  "deepseek-flash": "minimaxai/minimax-m3",
  "deepseek-pro": "deepseek-ai/deepseek-v4-flash-0731",
  "mistral": "minimaxai/minimax-m3"
};

var FALLBACKS = {
  "minimaxai/minimax-m3": [
    "deepseek-ai/deepseek-v4-flash-0731"
  ],

  "deepseek-ai/deepseek-v4-flash-0731": [
    "minimaxai/minimax-m3"
  ]
};

async function callNVIDIA(
  model,
  messages,
  body,
  env,
  signal
) {
  return fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",
      signal,

      headers: {
        Authorization: `Bearer ${env.NIM_API_KEY}`,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        model,
        messages,

        temperature:
          body.temperature ?? 0.85,

        max_tokens:
          body.max_tokens ?? 8024,

        stream: true
      })
    }
  );
}

__name(callNVIDIA, "callNVIDIA");

var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods":
            "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization"
        }
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", {
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // JanitorAI endpoint
    if (
      url.pathname !==
      "/v1/chat/completions"
    ) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Parse JSON
    let body;

    try {
      body = await request.json();
    } catch {
      return new Response(
        "Invalid JSON",
        {
          status: 400,
          headers: {
            "Access-Control-Allow-Origin":
              "*"
          }
        }
      );
    }

    // Default to MiniMax M3
    const inputModel =
      body.model || "deepseek-flash";

    const primaryModel =
      MODEL_MAP[inputModel] ||
      "minimaxai/minimax-m3";

    const messages =
      Array.isArray(body.messages) &&
      body.messages.length > 0
        ? body.messages
        : [
            {
              role: "user",
              content: "Hello"
            }
          ];

    // Primary + one fallback
    const chain = [
      primaryModel,
      ...(FALLBACKS[primaryModel] || [])
    ];

    let response = null;
    let lastError = null;

    // Try models
    for (const model of chain) {
      try {
        const controller =
          new AbortController();

        const timeout = setTimeout(
          () => controller.abort(),
          60000
        );

        let res;

        try {
          res = await callNVIDIA(
            model,
            messages,
            body,
            env,
            controller.signal
          );
        } finally {
          clearTimeout(timeout);
        }

        if (res.ok && res.body) {
          console.log(
            "MODEL USED:",
            model
          );

          response = res;
          break;
        }

        const errorText =
          await res.text();

        lastError = {
          model,
          status: res.status,
          error: errorText
        };

        console.log(
          "MODEL FAILED:",
          model,
          res.status,
          errorText
        );

      } catch (error) {
        lastError = {
          model,
          error:
            error?.message ||
            "Unknown error"
        };

        console.log(
          "MODEL ERROR:",
          model,
          error?.message
        );
      }
    }

    // Everything failed
    if (
      !response ||
      !response.body
    ) {
      return new Response(
        JSON.stringify({
          error:
            "All NVIDIA models failed",

          last_error:
            lastError,

          tried_models:
            chain
        }),
        {
          status: 500,

          headers: {
            "Content-Type":
              "application/json",

            "Access-Control-Allow-Origin":
              "*"
          }
        }
      );
    }

    // Stream NVIDIA -> JanitorAI
    const {
      readable,
      writable
    } = new TransformStream();

    const writer =
      writable.getWriter();

    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    const encoder =
      new TextEncoder();

    (async () => {
      try {
        let buffer = "";

        while (true) {
          const {
            done,
            value
          } = await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(
            value,
            {
              stream: true
            }
          );

          const lines =
            buffer.split("\n");

          buffer =
            lines.pop() || "";

          for (const line of lines) {
            if (
              !line.startsWith(
                "data: "
              )
            ) {
              continue;
            }

            if (
              line.includes(
                "[DONE]"
              )
            ) {
              await writer.write(
                encoder.encode(
                  "data: [DONE]\n\n"
                )
              );

              continue;
            }

            try {
              const json =
                JSON.parse(
                  line.slice(6)
                );

              // Hide reasoning from JanitorAI
              if (
                json.choices?.[0]
                  ?.delta
              ) {
                delete json
                  .choices[0]
                  .delta
                  .reasoning_content;

                delete json
                  .choices[0]
                  .delta
                  .reasoning;
              }

              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify(
                    json
                  )}\n\n`
                )
              );

            } catch {
              await writer.write(
                encoder.encode(
                  line + "\n\n"
                )
              );
            }
          }
        }

        await writer.close();

      } catch (error) {
        console.log(
          "STREAM ERROR:",
          error?.message
        );

        try {
          await writer.abort(
            error
          );
        } catch {}
      }
    })();

    return new Response(
      readable,
      {
        headers: {
          "Content-Type":
            "text/event-stream",

          "Access-Control-Allow-Origin":
            "*",

          "Cache-Control":
            "no-cache",

          "X-Accel-Buffering":
            "no"
        }
      }
    );
  }
};

export {
  index_default as default
};
