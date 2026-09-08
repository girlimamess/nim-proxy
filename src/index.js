const MODEL = "moonshotai/kimi-k3";

const NVIDIA_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response("OK", {
        status: 200,
        headers: corsHeaders()
      });
    }

    // Simple Kimi test
    if (url.pathname === "/test") {
      try {
        const response = await fetch(NVIDIA_URL, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.NIM_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              {
                role: "user",
                content: "Reply with exactly: Kimi K3 is working."
              }
            ],
            temperature: 0.7,
            max_tokens: 30,
            stream: false
          })
        });

        const text = await response.text();

        return new Response(
          "MODEL: " + MODEL +
          "\nNVIDIA STATUS: " + response.status +
          "\n\n" + text,
          {
            status: 200,
            headers: {
              ...corsHeaders(),
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      } catch (error) {
        return new Response(
          "NVIDIA FETCH ERROR:\n" +
          (error?.message || String(error)),
          {
            status: 502,
            headers: {
              ...corsHeaders(),
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      }
    }

    // JanitorAI endpoint
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", {
        status: 404,
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method not allowed" },
        405
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return jsonResponse(
        { error: "Invalid JSON request body" },
        400
      );
    }

    if (
      !Array.isArray(body.messages) ||
      body.messages.length === 0
    ) {
      return jsonResponse(
        { error: "messages is required" },
        400
      );
    }

    // Keep generation settings suitable for RP.
    const temperature =
      typeof body.temperature === "number"
        ? body.temperature
        : 0.85;

    const maxTokens = Math.min(
      typeof body.max_tokens === "number"
        ? body.max_tokens
        : 8192,
      8192
    );

    const stream =
      body.stream !== false;

    console.log(
      "JANITOR REQUEST:",
      "model=" + MODEL,
      "messages=" + body.messages.length,
      "stream=" + stream,
      "max_tokens=" + maxTokens
    );

    let response;

    try {
      response = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.NIM_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: MODEL,
          messages: body.messages,
          temperature,
          max_tokens: maxTokens,
          top_p:
            typeof body.top_p === "number"
              ? body.top_p
              : 0.95,
          stream
        })
      });
    } catch (error) {
      console.log(
        "NVIDIA FETCH ERROR:",
        error?.message || String(error)
      );

      return jsonResponse(
        {
          error: "NVIDIA connection failed",
          model: MODEL,
          message:
            error?.message || "Unknown connection error"
        },
        502
      );
    }

    console.log(
      "NVIDIA STATUS:",
      response.status
    );

    // Rate limit: do NOT automatically retry/fallback.
    if (response.status === 429) {
      const errorText = await response.text();

      const headers = {
        ...corsHeaders(),
        "Content-Type": "application/json; charset=utf-8"
      };

      const retryAfter =
        response.headers.get("Retry-After");

      if (retryAfter) {
        headers["Retry-After"] = retryAfter;
      }

      return new Response(
        JSON.stringify({
          error: "NVIDIA rate limit reached",
          model: MODEL,
          details: errorText
        }),
        {
          status: 429,
          headers
        }
      );
    }

    // Other NVIDIA errors
    if (!response.ok) {
      const errorText = await response.text();

      console.log(
        "NVIDIA ERROR:",
        response.status,
        errorText
      );

      return jsonResponse(
        {
          error: "NVIDIA returned an error",
          status: response.status,
          model: MODEL,
          details: errorText
        },
        response.status
      );
    }

    // Non-streaming response
    if (!stream) {
      const text = await response.text();

      return new Response(text, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "application/json; charset=utf-8"
        }
      });
    }

    if (!response.body) {
      return jsonResponse(
        {
          error: "NVIDIA returned no response body",
          model: MODEL
        },
        502
      );
    }

    // Stream NVIDIA → JanitorAI
    const { readable, writable } =
      new TransformStream();

    const writer = writable.getWriter();
    const reader = response.body.getReader();

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buffer = "";

      try {
        while (true) {
          const { done, value } =
            await reader.read();

          if (done) {
            break;
          }

          buffer += decoder.decode(value, {
            stream: true
          });

          const lines = buffer.split("\n");

          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              continue;
            }

            const payload = line.slice(6);

            if (payload === "[DONE]") {
              await writer.write(
                encoder.encode(
                  "data: [DONE]\n\n"
                )
              );

              continue;
            }

            try {
              const json = JSON.parse(payload);

              const delta =
                json.choices?.[0]?.delta;

              if (delta) {
                // Prevent reasoning from appearing
                // as visible RP text.
                delete delta.reasoning_content;
                delete delta.reasoning;
                delete delta.thinking;
              }

              await writer.write(
                encoder.encode(
                  "data: " +
                  JSON.stringify(json) +
                  "\n\n"
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
          error?.message || String(error)
        );

        try {
          await writer.abort(error);
        } catch {}
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no"
      }
    });
  }
};
