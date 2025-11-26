import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fs from "fs"; // ⬅️ NEW

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

// ---- Natural voice + phone-optimized system message ----
const SYSTEM_MESSAGE = `
  "You are a helpful, friendly, and professionally conversational AI assistant for Streamography Productions, " +
  "an audio/video, livestreaming, and podcast production company. " +
  "You speak naturally and conversationally, like a real human—never like a robot. " +
  "You are allowed to use light dad jokes and owl jokes when appropriate, but do not overdo it. " +
  "Use only the Streamography information provided below when talking about services, pricing, or policies. " +
  "If you are not sure about something, say you are not certain and invite the caller to schedule a call with a human producer.\n\n" +
  buildKnowledgeSnippet();

Voice style:
- Use short, natural sentences.
- Use contractions ("I'm", "you're", "that's", "we'll") whenever they sound natural.
- Add small pauses with commas, line breaks, or the occasional "..." when thinking.
- Keep an upbeat, relaxed tone, like a professional customer service rep having a good day.

Conversation style:
- Acknowledge what the caller says ("Gotcha", "Makes sense", "Okay, let me check that").
- Ask clarifying questions when you need more info.
- If you don't know something, say so honestly and then offer what you can.
- Keep most replies brief (1–3 sentences) unless the caller asks for more detail.

Personality:
- Stay positive and encouraging.
- When it feels appropriate, you may lightly use dad jokes or playful humor, but never overdo it and never ignore the caller's real concern just to make a joke.
- Do not use stiff, corporate-sounding phrases like "your call is important to us".

Pacing and turn-taking:
- Take a short, natural beat before answering, like a human who is thinking for half a second.
- Do not talk over the caller; wait for them to finish before responding.
`;

// Keep using alloy; it handles phone compression well.
const VOICE = "alloy";
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
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Please hold while we connect you to our A I voice assistant, powered by Twilio and Open A I Realtime.
  </Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Okay, you're all set. You can start talking now.
  </Say>
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
              threshold: 0.6,
              silence_duration_ms: 650,
              prefix_padding_ms: 300
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
        if (
          greetingSent ||
          !callReady ||
          !openAiSessionReady ||
          openAiWs.readyState !== WebSocket.OPEN
        ) {
          return;
        }

        greetingSent = true;
        console.log("Sending initial greeting to caller");

        // We keep using response.create, but nudge the model to start with a natural greeting.
        openAiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              // Instructions are already in the session; here we just gently steer the first turn.
              instructions: `${SYSTEM_MESSAGE}

For your first reply, greet the caller in a warm, natural way, and briefly ask how you can help today.`
            }
          })
        );
      };

      const handleSpeechStartedEvent = () => {
        // User barge-in while we’re talking: truncate current answer,
        // clear any queued marks, and let model listen again.
        if (
          markQueue.length > 0 &&
          responseStartTimestampTwilio != null &&
          streamSid
        ) {
          const elapsedTime =
            latestMediaTimestamp - responseStartTimestampTwilio;

          if (lastAssistantItem) {
            const truncateEvent = {
              type: "conversation.item.truncate",
              item_id: lastAssistantItem,
              content_index: 0,
              audio_end_ms: elapsedTime
            };
            openAiWs.send(JSON.stringify(truncateEvent));
          }

          connection.send(
            JSON.stringify({
              event: "clear",
              streamSid
            })
          );

          markQueue = [];
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
          aiResponseInProgress = false;
        }
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
          }

          if (response.type === "response.done") {
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

            const audioDelta = {
              event: "media",
              streamSid,
              media: { payload: audioPayload }
            };
            connection.send(JSON.stringify(audioDelta));

            if (!responseStartTimestampTwilio) {
              responseStartTimestampTwilio = latestMediaTimestamp;
            }

            if (response.item_id) {
              lastAssistantItem = response.item_id;
            }
            sendMark();
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
