export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // health check
    if (url.pathname === "/health") {
      return new Response("OK");
    }

    // OpenAI endpoint
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("Not Found", { status: 404 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const response = await fetch(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.NIM_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "deepseek-ai/deepseek-v4-flash",
          messages: body.messages || [],
          temperature: body.temperature ?? 0.9,
          max_tokens: Math.min(body.max_tokens || 6024, 6024),
          stream: true
        })
      }
    );

    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }
};
