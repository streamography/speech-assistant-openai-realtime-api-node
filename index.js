// Streamography / Twilio Realtime Voice Assistant Bridge
// Twilio Media Streams <-> OpenAI Realtime API (audio in/out)

const Fastify = require("fastify");
const WebSocket = require("ws");
const dotenv = require("dotenv");
const fastifyFormBody = require("@fastify/formbody");
const fastifyWs = require("@fastify/websocket");

// Load environment variables
dotenv.config();

// Required env
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment variables.");
  process.exit(1);
}

// ------------------- Config (centralized) -------------------
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy"; // use a supported voice name
const INPUT_FORMAT = "g711_ulaw";   // Twilio Media Streams audio format (pcmu / G.711 u-law)
const OUTPUT_FORMAT = "g711_ulaw";
const TURN_DETECTION = { type: "server_vad" };
const DEBUG = process.env.DEBUG === "true";

// Your system prompt / brand voice
const SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE || `
You are "Streamy", the AI phone receptionist for Streamography Productions.
Speak warmly, clearly, and efficiently. Keep responses brief.
You can help callers understand services, gather event details,
and book an initial production meeting, but you cannot confirm bookings.
Ask clarifying questions when needed and summarize next steps.
`;

// Event types worth logging in debug mode
const LOG_EVENT_TYPES = [
  "error",
  "response.output_audio.delta",
  "response.text.delta",
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "session.created",
  "session.updated"
];

// ------------------- Server setup -------------------
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 10000;

// Helper: safely request a response from OpenAI (audio+text)
function requestAssistantResponse(openAiWs) {
  if (openAiWs.readyState !== WebSocket.OPEN) return;
  openAiWs.send(
    JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"] }
    })
  );
}

// ------------------- Twilio webhook: incoming call -------------------
fastify.post("/incoming-call", async (req, reply) => {
  // TwiML that tells Twilio to start a Media Stream to our WS endpoint
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/media-stream`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ------------------- Twilio Media Stream WS endpoint -------------------
fastify.get("/media-stream", { websocket: true }, (connection, req) => {
  let streamSid = null;
  let latestMediaTimestamp = 0;
  let responseStartTimestampTwilio = null;
  let markQueue = [];

  let silenceTimer = null; // debounce fallback if VAD events don't arrive

  // Connect to OpenAI Realtime WS
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  // Send correct GA session.update
  function initializeSession() {
    const sessionUpdate = {
      type: "session.update",
      session: {
        model: MODEL,
        modalities: ["audio", "text"],
        instructions: SYSTEM_MESSAGE,
        voice: VOICE,
        input_audio_format: INPUT_FORMAT,
        output_audio_format: OUTPUT_FORMAT,
        turn_detection: TURN_DETECTION
      }
    };

    if (DEBUG) console.log("Sending session update:", sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    // Have assistant greet first
    requestAssistantResponse(openAiWs);
  }

  // If caller starts talking while assistant is talking, cancel assistant and clear Twilio buffer
  function handleSpeechStartedEvent() {
    if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
      openAiWs.send(JSON.stringify({ type: "response.cancel" }));

      connection.socket.send(
        JSON.stringify({
          event: "clear",
          streamSid
        })
      );

      markQueue = [];
      responseStartTimestampTwilio = null;
    }
  }

  openAiWs.on("open", () => {
    if (DEBUG) console.log("Connected to OpenAI Realtime API");
    setTimeout(initializeSession, 100);
  });

  openAiWs.on("message", (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (DEBUG && LOG_EVENT_TYPES.includes(response.type)) {
        console.log(`OpenAI event: ${response.type}`, response);
      }

      // VAD end-of-turn -> respond
      if (response.type === "input_audio_buffer.speech_stopped") {
        if (DEBUG) console.log("VAD speech_stopped -> request response");
        requestAssistantResponse(openAiWs);
      }

      // Caller starts talking -> interrupt assistant
      if (response.type === "input_audio_buffer.speech_started") {
        handleSpeechStartedEvent();
      }

      // Stream assistant audio back to Twilio
      if (response.type === "response.output_audio.delta" && response.delta) {
        if (responseStartTimestampTwilio == null) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }

        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta }
        };

        connection.socket.send(JSON.stringify(audioDelta));

        // Mark to enable interruption
        const markEvent = {
          event: "mark",
          streamSid,
          mark: { name: "responsePart" }
        };
        connection.socket.send(JSON.stringify(markEvent));
        markQueue.push("responsePart");
      }
    } catch (err) {
      console.error("Error parsing OpenAI message:", err);
    }
  });

  openAiWs.on("close", () => {
    if (DEBUG) console.log("Disconnected from OpenAI Realtime API");
  });

  openAiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  // ------------------- Handle Twilio stream messages -------------------
  connection.socket.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      console.error("Bad Twilio message JSON:", e);
      return;
    }

    switch (data.event) {
      case "connected":
        if (DEBUG) console.log("Twilio connection established");
        break;

      case "start":
        streamSid = data.start.streamSid;
        if (DEBUG) console.log("Twilio stream started:", streamSid);
        latestMediaTimestamp = 0;
        responseStartTimestampTwilio = null;
        break;

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

        // Silence debounce fallback (~0.9s no audio => end of turn)
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          if (DEBUG) console.log("Silence debounce -> request response");
          requestAssistantResponse(openAiWs);
        }, 900);

        break;

      case "mark":
        if (markQueue.length > 0) markQueue.shift();
        break;

      case "stop":
        if (DEBUG) console.log("Twilio stream stopped");
        break;

      default:
        if (DEBUG) console.log("Twilio event:", data.event);
        break;
    }
  });

  connection.socket.on("close", () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    if (DEBUG) console.log("Twilio client disconnected");
  });
});

// ------------------- Start server -------------------
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server is listening on port ${PORT}`);
});