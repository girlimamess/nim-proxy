const MODEL_MAP = {
  "deepseek-flash":
    "deepseek-ai/deepseek-v4-flash-0731",

  "kimi":
    "moonshotai/kimi-k3",

  "nemotron":
    "nvidia/nemotron-3.5-lightning-30b-a3b",

  "gemma":
    "google/gemma-4-31b-it"
};

const FALLBACKS = {
  "deepseek-ai/deepseek-v4-flash-0731": [
    "moonshotai/kimi-k3",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "google/gemma-4-31b-it"
  ],

  "moonshotai/kimi-k3": [
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "google/gemma-4-31b-it"
  ],

  "nvidia/nemotron-3.5-lightning-30b-a3b": [
    "google/gemma-4-31b-it"
  ],

  "google/gemma-4-31b-it": []
};


// --------------------------------------------------
// NVIDIA REQUEST
// --------------------------------------------------

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
        Authorization:
          `Bearer ${env.NIM_API_KEY}`,

        "Content-Type":
          "application/json"
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


// --------------------------------------------------
// CORS
// --------------------------------------------------

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "POST, GET, OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
  };
}


// --------------------------------------------------
// WORKER
// --------------------------------------------------

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);


    // ------------------------------------------------
    // OPTIONS / CORS
    // ------------------------------------------------

    if (
      request.method === "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers:
            corsHeaders()
        }
      );
    }


    // ------------------------------------------------
    // HEALTH
    // ------------------------------------------------

    if (
      url.pathname === "/health"
    ) {
      return new Response(
        "OK",
        {
          headers:
            corsHeaders()
        }
      );
    }


    // ------------------------------------------------
    // TEST ENDPOINT
    // ------------------------------------------------

    if (
      url.pathname === "/test"
    ) {
      return new Response(
        JSON.stringify({
          ok: true,
          primary:
            "deepseek-ai/deepseek-v4-flash-0731",

          fallbacks: [
            "moonshotai/kimi-k3",
            "nvidia/nemotron-3.5-lightning-30b-a3b",
            "google/gemma-4-31b-it"
          ]
        }),
        {
          headers: {
            ...corsHeaders(),

            "Content-Type":
              "application/json"
          }
        }
      );
    }


    // ------------------------------------------------
    // JANITORAI ENDPOINT
    // ------------------------------------------------

    if (
      url.pathname !==
      "/v1/chat/completions"
    ) {
      return new Response(
        "Not Found",
        {
          status: 404,

          headers:
            corsHeaders()
        }
      );
    }


    // ------------------------------------------------
    // PARSE REQUEST
    // ------------------------------------------------

    let body;

    try {

      body =
        await request.json();

    } catch {

      return new Response(
        JSON.stringify({
          error:
            "Invalid JSON"
        }),
        {
          status: 400,

          headers: {
            ...corsHeaders(),

            "Content-Type":
              "application/json"
          }
        }
      );
    }


    // ------------------------------------------------
    // DEFAULT MODEL
    //
    // DeepSeek V4 Flash is primary.
    // ------------------------------------------------

    const inputModel =
      body.model ||
      "deepseek-flash";


    const primaryModel =
      MODEL_MAP[inputModel] ||
      "deepseek-ai/deepseek-v4-flash-0731";


    // ------------------------------------------------
    // MESSAGES
    // ------------------------------------------------

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


    // ------------------------------------------------
    // MODEL CHAIN
    // ------------------------------------------------

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


    let response = null;

    let lastError = null;


    // ------------------------------------------------
    // TRY MODELS
    // ------------------------------------------------

    for (
      let modelIndex = 0;
      modelIndex < chain.length;
      modelIndex++
    ) {

      const model =
        chain[modelIndex];


      console.log(
        "TRYING MODEL:",
        model
      );


      try {

        const controller =
          new AbortController();


        /*
         * Don't let one broken NVIDIA
         * endpoint hang forever.
         *
         * 25 seconds is enough to catch
         * an endpoint that isn't responding,
         * while still giving the model
         * some time to start streaming.
         */

        const timeout =
          setTimeout(
            () => {
              console.log(
                "MODEL TIMEOUT:",
                model
              );

              controller.abort();
            },
            25000
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


        // --------------------------------------------
        // SUCCESS
        // --------------------------------------------

        if (
          res.ok &&
          res.body
        ) {

          console.log(
            "MODEL USED:",
            model
          );

          response =
            res;

          break;
        }


        // --------------------------------------------
        // READ ERROR
        // --------------------------------------------

        const errorText =
          await res.text();


        lastError = {
          model,
          status:
            res.status,
          error:
            errorText
        };


        console.log(
          "MODEL FAILED:",
          model,
          res.status,
          errorText
        );


        // --------------------------------------------
        // RATE LIMIT
        // --------------------------------------------

        if (
          res.status === 429
        ) {

          console.log(
            "429 - MOVING TO FALLBACK:",
            model
          );

          continue;
        }


        // --------------------------------------------
        // GATEWAY / SERVER ERRORS
        //
        // 500
        // 502
        // 503
        // 504
        // 524
        // etc.
        // --------------------------------------------

        if (
          res.status >= 500
        ) {

          console.log(
            "SERVER ERROR - MOVING TO FALLBACK:",
            model,
            res.status
          );

          continue;
        }


        // --------------------------------------------
        // OTHER ERROR
        // --------------------------------------------

        console.log(
          "NON-RETRYABLE MODEL ERROR:",
          model,
          res.status
        );

      } catch (error) {

        const message =
          error?.message ||
          "Unknown error";


        lastError = {
          model,
          error:
            message
        };


        console.log(
          "MODEL ERROR:",
          model,
          message
        );


        /*
         * AbortError / timeout /
         * connection failures should
         * immediately move to fallback.
         */

        console.log(
          "MOVING TO NEXT MODEL:",
          model
        );
      }
    }


    // ------------------------------------------------
    // EVERYTHING FAILED
    // ------------------------------------------------

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


    // ------------------------------------------------
    // STREAM RESPONSE
    // ------------------------------------------------

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


    // ------------------------------------------------
    // STREAM PROCESSOR
    // ------------------------------------------------

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
            const line of lines
          ) {

            if (
              !line.startsWith(
                "data: "
              )
            ) {
              continue;
            }


            // --------------------------------------
            // DONE
            // --------------------------------------

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


            // --------------------------------------
            // JSON
            // --------------------------------------

            try {

              const json =
                JSON.parse(
                  line.slice(6)
                );


              // Remove reasoning
              // fields from the stream.

              if (
                json
                  .choices?.[0]
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


    // ------------------------------------------------
    // RETURN STREAM
    // ------------------------------------------------

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
