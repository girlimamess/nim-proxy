const MODEL_MAP = {
  "llama-70b": "meta/llama-3.1-70b-instruct",
  "deepseek-flash": "deepseek-ai/deepseek-v4-flash",
  "deepseek-pro": "deepseek-ai/deepseek-v4-pro",
  "mistral": "mistralai/mistral-large-3-675b-instruct-2512"
};

// NVIDIA call
async function callNVIDIA(model, messages, body, env, signal) {
  return fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${env.NIM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: body.temperature ?? 0.9,
      max_tokens: Math.min(body.max_tokens || 8024, 8024),
      stream: true
    })
  });
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

    // Route guard
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Access-Control-Allow-Origin": "*"
        }
      });
    }

    // Parse request
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

    // Default model: DeepSeek Flash
    const inputModel = body.model || "deepseek-flash";

    const model =
      MODEL_MAP[inputModel] ||
      "deepseek-ai/deepseek-v4-flash";

    const messages =
      Array.isArray(body.messages) && body.messages.length > 0
        ? body.messages
        : [{ role: "user", content: "Hello" }];

    // Timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;

    try {
      response = await callNVIDIA(
        model,
        messages,
        body,
        env,
        controller.signal
      );
    } finally {
      clearTimeout(timeout);
    }

    // Show real NVIDIA errors
    if (!response || !response.ok || !response.body) {
      let errorText = "Unknown error";

      try {
        errorText = await response.text();
      } catch {}

      console.log("NVIDIA ERROR:", response?.status, errorText);

      return new Response(
        JSON.stringify({
          error: errorText,
          status: response?.status ?? 500
        }),
        {
          status: response?.status ?? 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // Stream cleaner
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = response.body.getReader();

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          if (line.includes("[DONE]")) {
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }

          try {
            const json = JSON.parse(line.slice(6));

            if (json.choices?.[0]?.delta) {
              delete json.choices[0].delta.reasoning_content;
            }

            await writer.write(
              encoder.encode(`data: ${JSON.stringify(json)}\n\n`)
            );
          } catch {
            await writer.write(encoder.encode(line + "\n\n"));
          }
        }
      }

      await writer.close();
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache"
      }
    });
  }
};
