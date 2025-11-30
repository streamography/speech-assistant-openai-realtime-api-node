import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fs from "fs";
import textToSpeech from "@google-cloud/text-to-speech";

dotenv.config();

// --- Google Cloud TTS client ---
// GOOGLE_APPLICATION_CREDENTIALS must point to your gcp-credentials.json
const gcpTtsClient = new textToSpeech.TextToSpeechClient();

// --- Load Streamography knowledge (Phase 1: inline JSON) ---
let streamographyKnowledge = {
  about: "",
  services: [],
  faq: []
};

try {
  const raw = fs.readFileSync("./streamography_knowledge.json", "utf8");
  streamographyKnowledge = JSON.parse(raw);
  console.log("Loaded Streamography knowledge file.");
} catch (err) {
  console.warn(
    "Could not load streamography_knowledge.json; proceeding with minimal context.",
    err.message
  );
}

/**
 * Build a compact knowledge snippet that we inject into the system message.
 * Keep it short and factual so the model doesn’t get overwhelmed.
 */
function buildKnowledgeSnippet() {
  const about = streamographyKnowledge.about || "";

  const services = (streamographyKnowledge.services || [])
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  const faq = (streamographyKnowledge.faq || [])
    .map((f) => `Q: ${f.q}\nA: ${f.a}`)
    .join("\n\n");

  return `
COMPANY CONTEXT: STREAMOGRAPHY PRODUCTIONS

About:
${about}

Core Services:
${services}

Common Questions:
${faq}
`.trim();
}

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Please set it in the .env file.");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---- Natural voice + phone-optimized system message with "friendly geek" persona ----
const SYSTEM_MESSAGE = `
You are a helpful, friendly, slightly geeky, and professionally conversational AI assistant for Streamography Productions,
an audio/video, livestreaming, and podcast production company.

Your personality:
- You sound like a confident, approachable tech nerd who really knows his stuff.
- You enjoy explaining things clearly and simply, without being condescending.
- You’re warm, upbeat, and you genuinely like talking to people.
- You can sprinkle in light, nerdy charm or dad-joke energy occasionally, but never overdo it.

Your role:
- Talk to callers like a real human support/sales rep on the phone.
- Be clear, warm, and confident.
- Use the company information below as your source of truth.

IMPORTANT COMPANY CONTEXT
Only rely on the following Streamography information when discussing services, capabilities, locations, or policies.
Do NOT invent details. If something is not mentioned here, say you are not completely sure and suggest speaking
with a human producer.

${buildKnowledgeSnippet()}

Pricing rules (VERY IMPORTANT):
- Never give specific prices, ranges, ballpark figures, budgets, or quotes.
- If a caller asks about pricing, estimates, or "how much it costs," say something like:
  "I don't have our current pricing in front of me, but we usually customize it based on the project.
  I can help you get connected with a producer who can give you an exact quote."
- You may talk about what affects pricing (scope, travel, crew size, etc.) but never state numbers or ranges.

Travel and locations:
- If callers ask how far Streamography travels, you may say:
  "We’ve done work from Hawaii to Portugal and nearly every time zone in between."
- Do NOT add extra locations or exaggerate. Use that sentence or a very close variation.

Voice style:
- Use short, natural sentences.
- Use contractions ("I'm", "you're", "that's", "we'll") whenever they sound natural.
- Sound relaxed, upbeat, slightly geeky, and human, not like a robot reading a script.
- Keep a moderate speaking pace: not rushed, not painfully slow.
- Speak with a warm, smooth tone.
- Avoid sharp or abrupt sentence starts.
- Let the first syllable of each response come in gently.
- Keep your cadence measured, like a friendly expert explaining something simply.

Conversation style:
- Keep most answers brief: 1–3 sentences unless the caller asks for more detail.
- Ask one clear question at a time when you need more information.
- Reflect back what the caller is asking before answering when helpful. Example:
  "Gotcha, you're asking about livestreaming your wedding ceremony. We can definitely help with that."
- Avoid stiff phrases like "your call is important to us." Talk like a real person.

Response openings:
- Avoid starting every reply with the same word ("Okay", "Sure", "Great").
- Vary your openings naturally: "Gotcha,", "Yeah, that makes sense,", "Absolutely,", "Good question," etc.
- Do not respond with just a single word like "Okay." Always follow it with a helpful phrase.

Response endings:
- Try to finish with a complete, natural thought, not an abrupt cut.
- Avoid trailing off with half sentences.
- It’s fine to end with a short supportive phrase like "Happy to help with that." when appropriate.

Personality:
- Stay positive and encouraging.
- Light dad jokes or playful, geeky humor are okay occasionally, but:
  - Never joke about serious issues.
  - Never ignore someone’s concern just to make a joke.
- If the caller seems stressed, focus on being calming and practical rather than funny.

Pacing and turn-taking:
- Imagine you are on a normal phone call:
  - Wait for the caller to finish before you respond.
  - Keep your responses short, then let them talk again.
- Do not talk over the caller. If they interrupt, stop and listen.
- Respond at a relaxed, human pace.
- Take a natural beat before speaking, as if you're thinking for a moment.
- Do NOT jump in instantly after the caller speaks. A small pause is good.
- Your delivery should sound slightly slower and smoother, not rushed or clipped.
- When beginning a sentence, ease into it with natural pacing rather than starting abruptly.

End-of-call behavior:
- If the caller says something like:
  "That's all I needed", "I'm all set", "That answers my question", or "Thanks, I'm good now":
  - Respond with a short, warm closing such as:
    "You're very welcome, thanks for calling Streamography. Have a great day!"
  - Optionally add one brief next step, like:
    "If you think of anything else, you can always call back or visit our website."
  - Then stop initiating new topics. Only speak again if the caller asks something else.

If you are not sure about something:
- Be honest. Say you don't have that exact information.
- Offer what you can: explain the general idea, or suggest connecting with a human producer.
`;

// voice param is still sent to OpenAI, but only text comes back
const VOICE = "verse";
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
  "error",
  "response.created",
  "response.done",
  "response.output_text.delta",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "conversation.item.created",
  "session.created",
  "session.updated",
  "rate_limits.updated",
  "input_audio_transcription.completed"
];

fastify.get("/", async (_request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.all("/incoming-call", async (request, reply) => {
  const host = request.headers.host;
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ---- Google TTS helper: text -> μ-law 8k Buffer ----
async function synthesizeWithGoogle(text) {
  if (!text || !text.trim()) return null;

  const request = {
    input: { text },
    voice: {
      languageCode: "en-US",
      name: "en-US-Standard-F"
    },
    audioConfig: {
      audioEncoding: "MULAW",
      sampleRateHertz: 8000
    }
  };

  const [response] = await gcpTtsClient.synthesizeSpeech(request);

  if (!response.audioContent) return null;

  const buf = Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent, "binary");

  return buf;
}

// ---- Helper: stream Google μ-law audio back to Twilio in 20ms frames ----
function playGoogleTtsOnTwilio(streamSid, connection, audioBuffer) {
  if (!streamSid || !audioBuffer || audioBuffer.length === 0) return;

  // Twilio sends/receives 20ms frames of 160 μ-law bytes at 8kHz.
  // We pace our outbound frames similarly.
  const FRAME_SIZE_BYTES = 160;
  const FRAME_DURATION_MS = 20;

  let frameIndex = 0;
  for (
    let offset = 0;
    offset < audioBuffer.length;
    offset += FRAME_SIZE_BYTES, frameIndex++
  ) {
    const chunk = audioBuffer.subarray(offset, offset + FRAME_SIZE_BYTES);
    const payload = chunk.toString("base64");

    setTimeout(() => {
      if (connection.readyState === 1) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload }
        };
        connection.send(JSON.stringify(audioDelta));
      }
    }, frameIndex * FRAME_DURATION_MS);
  }
}

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/media-stream",
    { websocket: true },
    (connection, _req) => {
      console.log("Twilio client connected");

      let streamSid = null;
      let latestMediaTimestamp = 0;
      let responseStartTimestampTwilio = null;

      // Track if the model is currently speaking (for logging / barge-in).
      let aiResponseInProgress = false;

      // Handshake flags: Twilio call + OpenAI session readiness + greeting.
      let callReady = false; // Twilio "start" received, streamSid set
      let openAiSessionReady = false; // OpenAI "session.updated" received
      let greetingSent = false; // We have sent the initial response.create

      // Buffer for assistant's text response (OpenAI -> Google TTS)
      let currentAssistantText = "";

      const openAiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28",
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
          }
        }
      );

      const initializeSession = () => {
        if (openAiWs.readyState !== WebSocket.OPEN) return;

        const sessionUpdate = {
          type: "session.update",
          session: {
            // We only need text back; we'll handle audio with Google TTS
            modalities: ["text"],
            instructions: SYSTEM_MESSAGE,
            voice: VOICE,

            // Twilio -> OpenAI input audio is μ-law 8k
            input_audio_format: "g711_ulaw",

            // Natural server-side VAD for turn-taking
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: false,
              threshold: 0.75,
              silence_duration_ms: 900,
              prefix_padding_ms: 450
            },

            // Enable transcription (for logging / future features)
            input_audio_transcription: {
              model: "whisper-1"
            }
          }
        };

        console.log(
          "Sending session update:",
          JSON.stringify(sessionUpdate, null, 2)
        );
        openAiWs.send(JSON.stringify(sessionUpdate));
      };

      const maybeSendGreeting = () => {
        if (
          greetingSent ||
          !callReady ||
          !openAiSessionReady ||
          openAiWs.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        greetingSent = true;
        console.log("Scheduling initial greeting to caller");

        setTimeout(() => {
          if (openAiWs.readyState !== WebSocket.OPEN) {
            console.warn(
              "Skipped greeting because OpenAI WebSocket is no longer open."
            );
            return;
          }

          console.log("Sending initial greeting to caller now");

          openAiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["text"],
                instructions: `${SYSTEM_MESSAGE}

For your first reply, greet the caller in a warm, slightly geeky but professional way, and briefly ask how you can help today.`
              }
            })
          );
        }, 500);
      };

      const handleSpeechStartedEvent = () => {
        console.log(
          "Detected speech start during assistant response (potential barge-in)."
        );
      };

      openAiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime");
        setTimeout(initializeSession, 100);
      });

      openAiWs.on("message", async (data) => {
        try {
          const text =
            typeof data === "string" ? data : data.toString("utf8");
          const response = JSON.parse(text);

          console.log("OpenAI raw event:", response.type);

          if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log(`OpenAI event: ${response.type}`, response);
          }

          if (response.type === "session.updated") {
            openAiSessionReady = true;
            console.log("OpenAI session updated");
            maybeSendGreeting();
          }

          if (response.type === "response.created") {
            aiResponseInProgress = true;
            currentAssistantText = "";
          }

          if (response.type === "response.output_text.delta") {
            // Try to collect streaming text, but fall back to safe defaults
            let deltaText = "";
            if (typeof response.delta === "string") {
              deltaText = response.delta;
            } else if (typeof response.delta?.content === "string") {
              deltaText = response.delta.content;
            } else if (response.delta?.output_text) {
              // Newer formats may nest text here
              deltaText = response.delta.output_text;
            }

            if (deltaText) {
              currentAssistantText += deltaText;
            }
          }

          if (response.type === "response.done") {
            aiResponseInProgress = false;

            if (response.response?.status === "failed") {
              console.error(
                "Response failed details:",
                JSON.stringify(response.response?.status_details, null, 2)
              );
            }

            // If we somehow didn't collect text via deltas, try to pull it from the final response
            if (!currentAssistantText.trim()) {
              try {
                const r = response.response;
                if (r?.output_text?.length) {
                  currentAssistantText = r.output_text
                    .flatMap((o) =>
                      (o.content || [])
                        .map((c) => c.text || "")
                    )
                    .join("");
                } else if (r?.output?.length) {
                  currentAssistantText = r.output
                    .flatMap((o) =>
                      (o.content || [])
                        .map((c) => c.text || "")
                    )
                    .join("");
                }
              } catch (e) {
                console.warn("Could not reconstruct text from response.done:", e);
              }
            }

            // When the model has finished its turn, send the full text to Google TTS
            if (streamSid && currentAssistantText.trim().length > 0) {
              try {
                console.log(
                  "Final assistant text for TTS:",
                  currentAssistantText
                );

                const audioBuffer = await synthesizeWithGoogle(
                  currentAssistantText
                );

                if (audioBuffer && audioBuffer.length > 0) {
                  responseStartTimestampTwilio = latestMediaTimestamp;
                  playGoogleTtsOnTwilio(streamSid, connection, audioBuffer);
                } else {
                  console.warn(
                    "Google TTS returned no audioContent for this response."
                  );
                }
              } catch (ttsErr) {
                console.error("Error calling Google TTS:", ttsErr);
              } finally {
                currentAssistantText = "";
              }
            } else {
              currentAssistantText = "";
            }
          }

          if (response.type === "input_audio_buffer.speech_started") {
            handleSpeechStartedEvent();
          }

          if (response.type === "input_audio_buffer.committed") {
            console.log(
              "Input audio buffer committed for item:",
              response.item_id
            );
          }

          if (response.type === "input_audio_transcription.completed") {
            console.log(
              "Transcription completed:",
              response.transcript || response.output_text
            );
          }

          if (response.type === "error") {
            console.error(
              "OpenAI error:",
              JSON.stringify(response.error, null, 2)
            );
          }
        } catch (err) {
          console.error("Error processing OpenAI message:", err, data);
        }
      });

      connection.on("message", (message) => {
        try {
          const asString =
            typeof message === "string" ? message : message.toString("utf8");
          console.log("Raw Twilio WS message:", asString);

          const data = JSON.parse(asString);

          switch (data.event) {
            case "media":
              latestMediaTimestamp = data.media.timestamp;
              if (openAiWs.readyState === WebSocket.OPEN) {
                // Forward caller audio to OpenAI
                openAiWs.send(
                  JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: data.media.payload
                  })
                );
              }
              break;

            case "start":
              streamSid = data.start.streamSid;
              console.log("Incoming stream started:", streamSid);

              // Reset per-call state
              responseStartTimestampTwilio = null;
              latestMediaTimestamp = 0;
              aiResponseInProgress = false;
              currentAssistantText = "";

              // Mark call as ready and attempt greeting (if OpenAI session is ready).
              callReady = true;
              greetingSent = false;
              maybeSendGreeting();
              break;

            case "mark":
              // Not using mark queue here, but could log if needed
              console.log("Twilio mark event:", data.mark);
              break;

            case "stop":
              console.log("Twilio stream stopped:", streamSid);
              break;

            default:
              console.log("Twilio non-media event:", data.event, data);
          }
        } catch (err) {
          console.error("Error parsing Twilio message:", err, message);
        }
      });

      connection.on("close", () => {
        if (openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
        console.log("Twilio client disconnected");

        // Reset handshake flags
        callReady = false;
        openAiSessionReady = false;
        greetingSent = false;
        aiResponseInProgress = false;
      });

      openAiWs.on("close", () => {
        console.log("OpenAI realtime socket closed");
        aiResponseInProgress = false;
      });

      openAiWs.on("error", (error) => {
        console.error("Error in OpenAI WebSocket:", error);
        aiResponseInProgress = false;
      });
    }
  );
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on port ${PORT}`);
});
