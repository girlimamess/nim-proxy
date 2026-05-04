const MODEL_MAP = {
  "llama-70b": "meta/llama-3.1-70b-instruct",
  "deepseek-flash": "deepseek-ai/deepseek-v4-flash",
  "deepseek-pro": "deepseek-ai/deepseek-v4-pro",
  "mistral": "mistralai/mistral-large-3-675b-instruct-2512"
};

// 🔁 fallback chain (FIXED KEY USAGE)
const FALLBACKS = {
  "llama-70b": [
    "meta/llama-3.1-8b-instruct"
  ],
  "deepseek-pro": [
    "deepseek-ai/deepseek-v4-flash",
    "meta/llama-3.1-70b-instruct"
  ],
  "deepseek-flash": [
    "meta/llama-3.1-70b-instruct"
  ],
  "mistral": [
    "meta/llama-3.1-70b-instruct"
  ]
};

// 🔥 NVIDIA CALL (with timeout protection)
async function callNVIDIA(model, messages, body, env) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
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

    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 🔁 CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    // 🩺 Health check
    if (url.pathname === "/health") {
      return new Response("OK", {
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // 🚫 Route guard
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" }
      });
    }

    // 📦 parse request
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // 🎯 model selection
    const selectedModel =
      MODEL_MAP[body.model] || "meta/llama-3.1-70b-instruct";

    const messages =
      Array.isArray(body.messages) && body.messages.length > 0
        ? body.messages
        : [{ role: "user", content: "Hello" }];

    // 🔁 fallback chain FIXED (uses input model key)
    const chain = [
      selectedModel,
      ...(FALLBACKS[body.model] || [])
    ];

    let response = null;

    // 🔁 try models
    for (const model of chain) {
      try {
        const res = await callNVIDIA(model, messages, body, env);
        if (res && res.body) {
          response = res;
          break;
        }
      } catch {
        response = null;
      }
    }

    if (!response || !response.body) {
      return new Response(
        JSON.stringify({ error: "All models failed" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    // 🔥 STREAM FIX (JanitorAI safe)
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

      writer.close();
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
