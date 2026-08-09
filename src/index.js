const MODEL_MAP = {
  "llama-70b": "meta/llama-3.1-70b-instruct",
  "deepseek-flash": "deepseek-ai/deepseek-v4-flash",
  "deepseek-pro": "deepseek-ai/deepseek-v4-pro",
  "mistral": "mistralai/mistral-large-3-675b-instruct-2512"
};

// Fallback only when the selected model fails
const FALLBACKS = {
  "deepseek-ai/deepseek-v4-flash": [
    "meta/llama-3.1-70b-instruct"
  ],

  "deepseek-ai/deepseek-v4-pro": [
    "deepseek-ai/deepseek-v4-flash",
    "meta/llama-3.1-70b-instruct"
  ],

  "meta/llama-3.1-70b-instruct": [
    "meta/llama-3.1-8b-instruct"
  ],

  "mistralai/mistral-large-3-675b-instruct-2512": [
    "meta/llama-3.1-70b-instruct"
  ]
};

async function callNVIDIA(model, messages, body, env, signal) {
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
        temperature: body.temperature ?? 0.85,
        max_tokens: Math.min(
          body.max_tokens || 8024,
          8024
        ),
        stream: true,

        ...(model.includes("deepseek") && {
          chat_template_kwargs: {
            enable_thinking: true,
            thinking: true
          }
        })
      })
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
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
    if (url.pathname !== "/v1/chat/completions") {
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
      return new Response("Invalid JSON", {
        status: 400,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // DeepSeek Flash is the default
    const inputModel =
      body.model || "deepseek-flash";

    const primaryModel =
      MODEL_MAP[inputModel] ||
      "deepseek-ai/deepseek-v4-flash";

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

    // Build fallback chain
    const chain = [
      primaryModel,
      ...(FALLBACKS[primaryModel] || [])
    ];

    let response = null;
    let lastError = null;

    // Try primary + fallbacks
    for (const model of chain) {
      try {
        const controller = new AbortController();

        const timeout = setTimeout(
          () => controller.abort(),
          25000
        );

        const res = await callNVIDIA(
          model,
          messages,
          body,
          env,
          controller.signal
        );

        clearTimeout(timeout);

        if (res.ok && res.body) {
          console.log("MODEL USED:", model);

          response = res;
          break;
        }

        const errorText = await res.text();

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
          error: error?.message || "Unknown error"
        };

        console.log(
          "MODEL ERROR:",
          model,
          error?.message
        );
      }
    }

    // Everything failed
    if (!response || !response.body) {
      return new Response(
        JSON.stringify({
          error: "All NVIDIA models failed",
          last_error: lastError,
          tried_models: chain
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // Stream NVIDIA response to JanitorAI
    const { readable, writable } =
      new TransformStream();

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
          const { done, value } =
            await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(
            value,
            { stream: true }
          );

          const lines =
            buffer.split("\n");

          buffer =
            lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }

            if (line.includes("[DONE]")) {
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

              // Hide DeepSeek reasoning from JanitorAI
              if (
                json.choices?.[0]?.delta
              ) {
                delete json.choices[0]
                  .delta
                  .reasoning_content;
              }

              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify(json)}\n\n`
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

        // Process any remaining buffered data
        if (buffer.startsWith("data: ")) {
          try {
            const json =
              JSON.parse(
                buffer.slice(6)
              );

            if (
              json.choices?.[0]?.delta
            ) {
              delete json.choices[0]
                .delta
                .reasoning_content;
            }

            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify(json)}\n\n`
              )
            );
          } catch {
            // Ignore incomplete final chunk
          }
        }

        await writer.close();

      } catch (error) {
        console.log(
          "STREAM ERROR:",
          error?.message
        );

        try {
          await writer.abort(error);
        } catch {}
      }
    })();

    return new Response(readable, {
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
    });
  }
};
