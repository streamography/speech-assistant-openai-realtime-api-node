import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fs from "fs";

dotenv.config();

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
  console.error("Missing OpenAI API key. Please set it in the .env file.");
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

// Use "fable" voice – more natural & conversational
const VOICE = "fable";
// Currently unused, but kept for future tuning if needed.
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
  "error",
  "response.created",
  "response.done",
  "response.audio.delta",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "conversation.item.created",
  "session.created",
  "session.updated",
  "rate_limits.updated",
  "input_audio_transcription.completed"
];

// Currently unused timing flag, kept for debugging if you want later.
const SHOW_TIMING_MATH = false;

fastify.get("/", async (_request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/media-stream",
    { websocket: true },
    (connection, _req) => {
      console.log("Twilio client connected");

      let streamSid = null;
      let latestMediaTimestamp = 0;
      let lastAssistantItem = null;
      let markQueue = [];
      let responseStartTimestampTwilio = null;

      // Track if the model is currently speaking (for logging / barge-in).
      let aiResponseInProgress = false;

      // For smoothing audio starts: buffer a few chunks before sending.
      let pendingAudioChunks = [];
      let hasFlushedInitialAudio = false;
      const INITIAL_CHUNKS_BEFORE_FLUSH = 6; // tune 3–6 if needed

      // Handshake flags: Twilio call + OpenAI session readiness + greeting.
      let callReady = false; // Twilio "start" received, streamSid set
      let openAiSessionReady = false; // OpenAI "session.updated" received
      let greetingSent = false; // We have sent the initial response.create

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
            modalities: ["audio", "text"],
            instructions: SYSTEM_MESSAGE,
            voice: VOICE,

            // Twilio <-> OpenAI codec must match
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",

            // ---- Tuned server VAD for more natural turn-taking on phone audio ----
            turn_detection: {
              type: "server_vad",
              // Let the model auto-create responses after each user turn.
              create_response: true,
              // More human if we don't hard-barge over ourselves.
              interrupt_response: false,
              // Slightly lower threshold and longer pause to avoid cutting callers off.
              threshold: 0.75,
              silence_duration_ms: 900,
              prefix_padding_ms: 450
            },

            // Enable transcription
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
        // Only send the greeting once, and only after:
        // - Twilio stream has started (callReady)
        // - OpenAI session is updated (openAiSessionReady)
        // - WebSocket is actually open
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

        // Small delay so the line feels more natural and less “instant robot”
        setTimeout(() => {
          // Safety check in case the socket closed in the meantime
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
                modalities: ["audio", "text"],
                // Nudge the first reply toward a natural, friendly opening.
                instructions: `${SYSTEM_MESSAGE}

For your first reply, greet the caller in a warm, slightly geeky but professional way, and briefly ask how you can help today.`
              }
            })
          );
        }, 500); // you can experiment: 250–600ms
      };

      const handleSpeechStartedEvent = () => {
        // We avoid hard barge-in truncation here to prevent chopping sentences.
        console.log(
          "Detected speech start during assistant response (potential barge-in)."
        );
      };

      const sendMark = () => {
        if (!streamSid) return;
        connection.send(
          JSON.stringify({
            event: "mark",
            streamSid,
            mark: { name: "responsePart" }
          })
        );
        markQueue.push("responsePart");
      };

      // Helper to flush any buffered initial audio to Twilio
      const flushPendingAudio = () => {
        if (!streamSid || pendingAudioChunks.length === 0) return;

        for (const payload of pendingAudioChunks) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload }
          };
          connection.send(JSON.stringify(audioDelta));
          sendMark();
        }

        pendingAudioChunks = [];
        hasFlushedInitialAudio = true;
      };

      openAiWs.on("open", () => {
        console.log("Connected to OpenAI Realtime");
        // Small delay just to be safe before sending session.update.
        setTimeout(initializeSession, 100);
      });

      openAiWs.on("message", (data) => {
        try {
          // ws can deliver a Buffer; normalize to string before JSON.parse
          const text =
            typeof data === "string" ? data : data.toString("utf8");
          const response = JSON.parse(text);

          // TEMP: see everything
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
            // New response: reset initial audio buffer
            pendingAudioChunks = [];
            hasFlushedInitialAudio = false;
          }

          if (response.type === "response.done") {
            // Ensure any short replies that never hit the buffer threshold still get sent
            flushPendingAudio();

            aiResponseInProgress = false;

            if (response.response?.status === "failed") {
              console.error(
                "Response failed details:",
                JSON.stringify(response.response?.status_details, null, 2)
              );
            }
          }

          // MAIN HANDLER: forward OpenAI audio back to Twilio
          if (response.type === "response.audio.delta") {
            if (!response.delta) {
              console.warn(
                "response.audio.delta event received without a delta field"
              );
              return;
            }

            // Don’t send audio to Twilio until we have a valid streamSid.
            if (!streamSid) {
              console.warn(
                "Skipping audio delta because streamSid is not set yet"
              );
              return;
            }

            let audioPayload;
            try {
              // Decode + re-encode as a sanity check; Twilio still expects base64 in JSON.
              const decoded = Buffer.from(response.delta, "base64");
              audioPayload = decoded.toString("base64");
            } catch (e) {
              console.error("Failed to process audio delta base64:", e);
              return;
            }

            // --- Smooth: buffer the first few chunks before sending ---
            if (!hasFlushedInitialAudio) {
              pendingAudioChunks.push(audioPayload);

              // Once we have enough buffered, flush them all at once
              if (pendingAudioChunks.length >= INITIAL_CHUNKS_BEFORE_FLUSH) {
                flushPendingAudio();
              }
            } else {
              // After initial flush, stream normally
              const audioDelta = {
                event: "media",
                streamSid,
                media: { payload: audioPayload }
              };
              connection.send(JSON.stringify(audioDelta));
              sendMark();
            }

            if (!responseStartTimestampTwilio) {
              responseStartTimestampTwilio = latestMediaTimestamp;
            }

            if (response.item_id) {
              lastAssistantItem = response.item_id;
            }
          }

          if (response.type === "input_audio_buffer.speech_started") {
            handleSpeechStartedEvent();
          }

          // With auto-response enabled, we don't need to manually
          // trigger response.create on committed audio or transcription.
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
          const data = JSON.parse(message);

          switch (data.event) {
            case "media":
              latestMediaTimestamp = data.media.timestamp;
              if (openAiWs.readyState === WebSocket.OPEN) {
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
              markQueue = [];
              lastAssistantItem = null;
              pendingAudioChunks = [];
              hasFlushedInitialAudio = false;

              // Mark call as ready and attempt greeting (if OpenAI session is ready).
              callReady = true;
              greetingSent = false;
              maybeSendGreeting();
              break;

            case "mark":
              if (markQueue.length > 0) {
                markQueue.shift();
              }
              break;

            case "stop":
              console.log("Twilio stream stopped:", streamSid);
              break;

            default:
              console.log("Twilio non-media event:", data.event);
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
