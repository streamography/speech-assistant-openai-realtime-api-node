import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const SYSTEM_MESSAGE =
  "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
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
    Please wait while we connect your call to the A. I. voice assistant, powered by Twilio and the Open A I Realtime API
  </Say>
  <Pause length="1"/>
  <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K. you can start talking!</Say>
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

      // Ensure we only send the explicit greeting once per call.
      let hasSentInitialGreeting = false;

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

            turn_detection: {
              type: "server_vad",
              // Let the model auto-create responses after each user turn.
              create_response: true,
              interrupt_response: true,
              threshold: 0.7,
              silence_duration_ms: 500,
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

      const handleSpeechStartedEvent = () => {
        // User barge-in while we’re talking: truncate current answer,
        // clear any queued marks, and let model listen again.
        if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
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
          const response = JSON.parse(data);

          // TEMP: see everything
          console.log("OpenAI raw event:", response.type);

          if (LOG_EVENT_TYPES.includes(response.type)) {
            console.log(`OpenAI event: ${response.type}`, response);
          }

          // Once the session is updated the first time, send an explicit greeting.
          if (response.type === "session.updated" && !hasSentInitialGreeting) {
            hasSentInitialGreeting = true;
            console.log("Sending initial greeting to caller");

            openAiWs.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  modalities: ["audio", "text"],
                  // Instructions are already in the session; including them again is fine.
                  instructions: SYSTEM_MESSAGE
                }
              })
            );
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

          if (response.type === "response.audio.delta" && response.audio) {
            const audioDelta = {
              event: "media",
              streamSid,
              media: { payload: response.audio }
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
              hasSentInitialGreeting = false;
              break;

            case "mark":
              if (markQueue.length > 0) {
                markQueue.shift();
              }
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
