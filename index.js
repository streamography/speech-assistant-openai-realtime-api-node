import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

// ===== Env =====
const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var.");
  process.exit(1);
}

// If Twilio can't resolve request.headers.host reliably, set RENDER_HOST in Render env vars.
// Example: speech-assistant-openai-realtime-api-node-ehqo.onrender.com
const RENDER_HOST =
  process.env.RENDER_HOST || "speech-assistant-openai-realtime-api-node-ehqo.onrender.com";

// ===== App =====
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ===== Config =====
const SYSTEM_MESSAGE =
  process.env.SYSTEM_MESSAGE ||
  "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.8);
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = new Set([
  "error",
  "response.content.done",
  "rate_limits.updated",
  "response.done",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "session.updated",
]);

const SHOW_TIMING_MATH = false;

// Root
fastify.get("/", async (_req, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" });
});

// Twilio webhook for incoming calls
fastify.all("/incoming-call", async (_request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">
    Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open A I Realtime API.
  </Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K. you can start talking!</Say>
  <Connect>
    <Stream url="wss://${RENDER_HOST}/media-stream" />
  </Connect>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for Twilio Media Streams
fastify.register(async (f) => {
  f.get("/media-stream", { websocket: true }, (connection, _req) => {
    console.log("Twilio client connected");

    // Connection-specific state
    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // Send initial conversation item if AI talks first
    const sendInitialConversationItem = () => {
      const initialConversationItem = {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"',
            },
          ],
        },
      };

      if (SHOW_TIMING_MATH) {
        console.log("Sending initial conversation item:", initialConversationItem);
      }
      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    // Control initial session with OpenAI
    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          // required fields
          type: "realtime",
          modalities: ["audio"],
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
        },
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));

      // If you want the AI to greet first, uncomment:
      // sendInitialConversationItem();
    };

    // Handle interruption when caller starts speaking
    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
        if (SHOW_TIMING_MATH) {
          console.log(
            `Truncation elapsed time: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );
        }

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime,
          };
          if (SHOW_TIMING_MATH) console.log("Sending truncate:", truncateEvent);
          openAiWs.send(JSON.stringify(truncateEvent));
        }

        connection.send(
          JSON.stringify({
            event: "clear",
            streamSid,
          })
        );

        // reset
        markQueue = [];
        lastAssistantItem = null;
        responseStartTimestampTwilio = null;
      }
    };

    // Send mark so Twilio tells us when playback finished
    const sendMark = () => {
      if (!streamSid) return;
      const markEvent = {
        event: "mark",
        streamSid,
        mark: { name: "responsePart" },
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 100);
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.has(response.type)) {
          console.log(`OpenAI event: ${response.type}`, response);
        }

        if (response.type === "response.output_audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload: response.delta },
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;
            if (SHOW_TIMING_MATH) {
              console.log("Response start timestamp:", responseStartTimestampTwilio);
            }
          }

          if (response.item_id) lastAssistantItem = response.item_id;

          sendMark();
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }

        if (response.type === "input_audio_buffer.speech_stopped") {
          console.log("Detected end of caller speech — requesting AI response");
          openAiWs.send(JSON.stringify({ type: "response.create" }));
        }
      } catch (err) {
        console.error("Error processing OpenAI message:", err, "Raw:", data);
      }
    });

    // Messages from Twilio
    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid;
            console.log("Incoming stream started:", streamSid);
            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            break;

          case "media":
            latestMediaTimestamp = data.media.timestamp;
            if (SHOW_TIMING_MATH) {
              console.log("Twilio media timestamp:", latestMediaTimestamp);
            }
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: data.media.payload,
                })
              );
            }
            break;

          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            console.log("Twilio non-media event:", data.event);
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err, "Raw:", message);
      }
    });

    connection.on("close", () => {
      console.log("Twilio client disconnected");
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on("close", () => {
      console.log("OpenAI realtime socket closed");
    });

    openAiWs.on("error", (error) => {
      console.error("OpenAI websocket error:", error);
    });
  });
});

// Start server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on port ${PORT}`);
});
