const MODEL_MAP = {
  "mistral-nemotron": "mistralai/mistral-nemotron",
  "deepseek-flash": "deepseek-ai/deepseek-v4-flash-0731"
};

const FALLBACKS = {
  "mistralai/mistral-nemotron": [
    "deepseek-ai/deepseek-v4-flash-0731"
  ],

  "deepseek-ai/deepseek-v4-flash-0731": []
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

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
        stream: true
      })
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ----------------------------------------
    // CORS
    // ----------------------------------------

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders()
      });
    }

    // ----------------------------------------
    // HEALTH CHECK
    // ----------------------------------------

    if (url.pathname === "/health") {
      return new Response("OK", {
        headers: corsHeaders()
      });
    }

    // ----------------------------------------
    // CHAT ENDPOINT
    // ----------------------------------------

    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", {
        status: 404,
        headers: corsHeaders()
      });
    }

    // ----------------------------------------
    // PARSE JSON
    // ----------------------------------------

    let body;

    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: "Invalid JSON"
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders(),
            "Content-Type": "application/json"
          }
        }
      );
    }

    // ----------------------------------------
    // DEFAULT MODEL
    // ----------------------------------------
    //
    // Mistral Nemotron is the main model.
    //

    const inputModel =
      body.model || "mistral-nemotron";

    const primaryModel =
      MODEL_MAP[inputModel] ||
      "mistralai/mistral-nemotron";

    // ----------------------------------------
    // MESSAGES
    // ----------------------------------------

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

    // ----------------------------------------
    // MODEL CHAIN
    // ----------------------------------------

    const chain = [
      primaryModel,
      ...(FALLBACKS[primaryModel] || [])
    ];

    console.log(
      "MODEL CHAIN:",
      chain
    );

    let response = null;
    let lastError = null;

    // ----------------------------------------
    // TRY MODELS
    // ----------------------------------------

    for (
      let modelIndex = 0;
      modelIndex < chain.length;
      modelIndex++
    ) {
      const model = chain[modelIndex];

      console.log(
        "TRYING MODEL:",
        model
      );

      try {
        const controller =
          new AbortController();

        // 90 second timeout
        const timeout = setTimeout(
          () => controller.abort(),
          90000
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
        } catch (error) {
          console.log(
            "NVIDIA FETCH ERROR:",
            model,
            error?.message
          );

          lastError = {
            model,
            error:
              error?.message ||
              "NVIDIA fetch failed"
          };

          continue;
        } finally {
          clearTimeout(timeout);
        }

        // ------------------------------------
        // SUCCESS
        // ------------------------------------

        if (res.ok && res.body) {
          console.log(
            "MODEL USED:",
            model
          );

          response = res;
          break;
        }

        // ------------------------------------
        // 429 RATE LIMIT
        // ------------------------------------
        //
        // Do not immediately hammer NVIDIA
        // with another request.
        //

        if (res.status === 429) {
          const errorText =
            await res.text();

          console.log(
            "NVIDIA RATE LIMITED:",
            model,
            errorText
          );

          lastError = {
            model,
            status: 429,
            error: errorText
          };

          // Try fallback without retrying
          // the rate-limited model.
          continue;
        }

        // ------------------------------------
        // 524 / TIMEOUT
        // ------------------------------------

        if (res.status === 524) {
          const errorText =
            await res.text();

          console.log(
            "NVIDIA 524 TIMEOUT:",
            model,
            errorText
          );

          lastError = {
            model,
            status: 524,
            error: errorText
          };

          // Move directly to fallback.
          continue;
        }

        // ------------------------------------
        // OTHER NVIDIA ERROR
        // ------------------------------------

        const errorText =
          await res.text();

        console.log(
          "NVIDIA MODEL FAILED:",
          model,
          res.status,
          errorText
        );

        lastError = {
          model,
          status: res.status,
          error: errorText
        };

      } catch (error) {
        console.log(
          "MODEL ERROR:",
          model,
          error?.message
        );

        lastError = {
          model,
          error:
            error?.message ||
            "Unknown error"
        };
      }
    }

    // ----------------------------------------
    // ALL MODELS FAILED
    // ----------------------------------------

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
          status: 502,
          headers: {
            ...corsHeaders(),
            "Content-Type":
              "application/json"
          }
        }
      );
    }

    // ----------------------------------------
    // STREAM RESPONSE
    // ----------------------------------------

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
              !line.startsWith("data: ")
            ) {
              continue;
            }

            // --------------------------------
            // DONE
            // --------------------------------

            if (
              line.includes("[DONE]")
            ) {
              await writer.write(
                encoder.encode(
                  "data: [DONE]\n\n"
                )
              );

              continue;
            }

            // --------------------------------
            // PARSE SSE
            // --------------------------------

            try {
              const json =
                JSON.parse(
                  line.slice(6)
                );

              // Remove reasoning fields
              // before JanitorAI receives them.

              if (
                json.choices?.[0]?.delta
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
          await writer.abort(error);
        } catch {}
      }
    })();

    // ----------------------------------------
    // RETURN STREAM
    // ----------------------------------------

    return new Response(
      readable,
      {
        headers: {
          ...corsHeaders(),

          "Content-Type":
            "text/event-stream",

          "Cache-Control":
            "no-cache, no-transform",

          "X-Accel-Buffering":
            "no",

          "Connection":
            "keep-alive"
        }
      }
    );
  }
};
