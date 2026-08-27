var __defProp = Object.defineProperty;
var __name = (target, value) =>
  __defProp(target, "name", {
    value,
    configurable: true
  });

// src/index.js

// ============================================================
// MODELS
// ============================================================

var MODEL_MAP = {
  "deepseek-flash": "deepseek-ai/deepseek-v4-flash-0731",
  "minimax": "minimaxai/minimax-m3"
};

// ============================================================
// FALLBACKS
// ============================================================

var FALLBACKS = {
  "deepseek-ai/deepseek-v4-flash-0731": [
    "minimaxai/minimax-m3"
  ],

  "minimaxai/minimax-m3": [
    "deepseek-ai/deepseek-v4-flash-0731"
  ]
};

// ============================================================
// NVIDIA REQUEST
// ============================================================

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
          Math.min(
            body.max_tokens || 8024,
            8024
          ),

        stream: true
      })
    }
  );
}

__name(callNVIDIA, "callNVIDIA");

// ============================================================
// SLEEP
// ============================================================

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
}

__name(sleep, "sleep");

// ============================================================
// RETRY-AFTER
// ============================================================

function getRetryAfterMs(response) {
  if (!response) {
    return 0;
  }

  const retryAfter =
    response.headers.get("Retry-After");

  if (!retryAfter) {
    return 0;
  }

  // Retry-After can be seconds
  const seconds =
    Number(retryAfter);

  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return Math.min(
      seconds * 1000,
      30000
    );
  }

  // Or an HTTP date
  const date =
    Date.parse(retryAfter);

  if (!Number.isNaN(date)) {
    return Math.max(
      0,
      Math.min(
        date - Date.now(),
        30000
      )
    );
  }

  return 0;
}

__name(
  getRetryAfterMs,
  "getRetryAfterMs"
);

// ============================================================
// BACKOFF
// ============================================================

async function rateLimitBackoff(
  response,
  attempt
) {
  const retryAfter =
    getRetryAfterMs(response);

  if (retryAfter > 0) {
    console.log(
      "429 RETRY-AFTER:",
      retryAfter,
      "ms"
    );

    await sleep(retryAfter);

    return;
  }

  // Conservative exponential backoff
  const base =
    Math.min(
      2000 *
        Math.pow(
          2,
          attempt
        ),
      10000
    );

  // Small random jitter
  const jitter =
    Math.floor(
      Math.random() * 1000
    );

  const delay =
    base + jitter;

  console.log(
    "429 BACKOFF:",
    delay,
    "ms"
  );

  await sleep(delay);
}

__name(
  rateLimitBackoff,
  "rateLimitBackoff"
);

// ============================================================
// WORKER
// ============================================================

var index_default = {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);

    // ========================================================
    // CORS
    // ========================================================

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          headers: {
            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Methods":
              "POST, GET, OPTIONS",

            "Access-Control-Allow-Headers":
              "Content-Type, Authorization"
          }
        }
      );
    }

    // ========================================================
    // HEALTH
    // ========================================================

    if (
      url.pathname === "/health"
    ) {

      return new Response(
        "OK",
        {
          headers: {
            "Access-Control-Allow-Origin":
              "*"
          }
        }
      );
    }

    // ========================================================
    // JANITORAI ENDPOINT
    // ========================================================

    if (
      url.pathname !==
      "/v1/chat/completions"
    ) {

      return new Response(
        "Not Found",
        {
          status: 404,

          headers: {
            "Access-Control-Allow-Origin":
              "*"
          }
        }
      );
    }

    // ========================================================
    // PARSE BODY
    // ========================================================

    let body;

    try {

      body =
        await request.json();

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

    // ========================================================
    // MODEL
    // ========================================================

    const inputModel =
      body.model ||
      "deepseek-flash";

    const primaryModel =
      MODEL_MAP[inputModel] ||
      "deepseek-ai/deepseek-v4-flash-0731";

    // ========================================================
    // MESSAGES
    // ========================================================

    const messages =
      Array.isArray(
        body.messages
      ) &&
      body.messages.length > 0

        ? body.messages

        : [
            {
              role: "user",
              content: "Hello"
            }
          ];

    // ========================================================
    // BUILD MODEL CHAIN
    // ========================================================

    const chain = [
      primaryModel,
      ...(FALLBACKS[
        primaryModel
      ] || [])
    ];

    console.log(
      "MODEL CHAIN:",
      chain
    );

    // ========================================================
    // TRY MODELS
    // ========================================================

    let response = null;

    let lastError = null;

    for (
      let modelIndex = 0;
      modelIndex < chain.length;
      modelIndex++
    ) {

      const model =
        chain[modelIndex];

      try {

        // ----------------------------------------------------
        // Only one attempt per model.
        // If NVIDIA says 429, we back off once and then
        // move to the fallback rather than hammering it.
        // ----------------------------------------------------

        const controller =
          new AbortController();

        const timeout =
          setTimeout(
            () =>
              controller.abort(),
            60000
          );

        let res;

        try {

          res =
            await callNVIDIA(
              model,
              messages,
              body,
              env,
              controller.signal
            );

        } finally {

          clearTimeout(
            timeout
          );
        }

        // ----------------------------------------------------
        // SUCCESS
        // ----------------------------------------------------

        if (
          res.ok &&
          res.body
        ) {

          console.log(
            "MODEL USED:",
            model
          );

          response = res;

          break;
        }

        // ----------------------------------------------------
        // 429 RATE LIMIT
        // ----------------------------------------------------

        if (
          res.status === 429
        ) {

          const errorText =
            await res.text();

          console.log(
            "RATE LIMITED:",
            model,
            errorText
          );

          lastError = {
            model,
            status: 429,
            error: errorText
          };

          // If there is another model,
          // wait briefly before switching.
          if (
            modelIndex <
            chain.length - 1
          ) {

            await rateLimitBackoff(
              res,
              0
            );
          }

          continue;
        }

        // ----------------------------------------------------
        // OTHER ERROR
        // ----------------------------------------------------

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

    // ========================================================
    // EVERYTHING FAILED
    // ========================================================

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

    // ========================================================
    // STREAM RESPONSE
    // ========================================================

    const {
      readable,
      writable
    } =
      new TransformStream();

    const writer =
      writable.getWriter();

    const reader =
      response.body.getReader();

    const decoder =
      new TextDecoder();

    const encoder =
      new TextEncoder();

    // ========================================================
    // STREAM PROCESSOR
    // ========================================================

    (async () => {

      try {

        let buffer = "";

        while (true) {

          const {
            done,
            value
          } =
            await reader.read();

          if (done) {
            break;
          }

          buffer +=
            decoder.decode(
              value,
              {
                stream: true
              }
            );

          const lines =
            buffer.split("\n");

          buffer =
            lines.pop() || "";

          for (
            const line
            of lines
          ) {

            if (
              !line.startsWith(
                "data: "
              )
            ) {
              continue;
            }

            // ------------------------------------------------
            // DONE
            // ------------------------------------------------

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

            // ------------------------------------------------
            // JSON
            // ------------------------------------------------

            try {

              const json =
                JSON.parse(
                  line.slice(6)
                );

              // Hide internal reasoning
              // from JanitorAI.

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

          await writer.abort(
            error
          );

        } catch {
        }
      }

    })();

    // ========================================================
    // RETURN STREAM
    // ========================================================

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

//# sourceMappingURL=index.js.map
