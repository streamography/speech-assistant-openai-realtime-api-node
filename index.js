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
const TEMPERATURE = 0.8;
const PORT = process.env.PORT || 5050;

const LOG_EVENT_TYPES = [
  "error",
  "response.created",
  "response.done",
  "response.output_audio.delta",
  "input_audio_buffer.committed",
  "input_audio_buffer.speech_stopped",
  "input_audio_buffer.speech_started",
  "session.created",
  "session.updated",
  "rate_limits.updated"
];

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

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, _req) => {
    console.log("Twilio client connected");

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    // Track whether OpenAI already has an active response
    let aiResponseInProgress = false;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}`,
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
          // IMPORTANT: OpenAI rejects ["audio"] alone. Must include text too.
          modalities: ["text", "audio"],
          instructions: SYSTEM_MESSAGE,
          voice: VOICE,

          // Twilio Media Streams send G.711 μ-law payloads
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          // IMPORTANT: We want to control when response.create happens.
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: true
          }
        }
      };

      console.log("Sending session update:", JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    };

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
                'Greet the user with "Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?"'
            }
          ]
        }
      };

      if (SHOW_TIMING_MATH) {
        console.log(
          "Sending initial conversation item:",
          JSON.stringify(initialConversationItem)
        );
      }

      openAiWs.send(JSON.stringify(initialConversationItem));
      openAiWs.send(JSON.stringify({ type: "response.create" }));
      aiResponseInProgress = true;
    };

    const handleSpeechStartedEvent = () => {
      if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
        const elapsedTime =
          latestMediaTimestamp - responseStartTimestampTwilio;

        if (SHOW_TIMING_MATH) {
          console.log(
            `Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`
          );
        }

        if (lastAssistantItem) {
          const truncateEvent = {
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsedTime
          };

          if (SHOW_TIMING_MATH) {
            console.log(
              "Sending truncation event:",
              JSON.stringify(truncateEvent)
            );
          }

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
      const markEvent = {
        event: "mark",
        streamSid,
        mark: { name: "responsePart" }
      };
      connection.send(JSON.stringify(markEvent));
      markQueue.push("responsePart");
    };

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime");
      setTimeout(initializeSession, 100);

      // If you want AI to speak first, uncomment:
      // sendInitialConversationItem();
    });

    openAiWs.on("message", (data) => {
      try {
        const response = JSON.parse(data);

        if (LOG_EVENT_TYPES.includes(response.type)) {
          console.log(`OpenAI event: ${response.type}`, response);
        }

        if (response.type === "response.created") {
          aiResponseInProgress = true;
        }

        if (response.type === "response.done") {
          aiResponseInProgress = false;
        }

        if (response.type === "response.output_audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: { payload: response.delta }
          };
          connection.send(JSON.stringify(audioDelta));

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp;

            if (SHOW_TIMING_MATH) {
              console.log(
                `Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`
              );
            }
          }

          if (response.item_id) lastAssistantItem = response.item_id;

          sendMark();
        }

        if (response.type === "input_audio_buffer.speech_started") {
          handleSpeechStartedEvent();
        }

        // Instead of creating response on speech_stopped (racey),
        // wait for committed, then create only if none in progress.
        if (response.type === "input_audio_buffer.committed") {
          if (!aiResponseInProgress) {
            console.log("Audio committed — requesting AI response");
            openAiWs.send(JSON.stringify({ type: "response.create" }));
            aiResponseInProgress = true;
          } else {
            if (SHOW_TIMING_MATH) {
              console.log("Skipped response.create (already in progress)");
            }
          }
        }
      } catch (err) {
        console.error(
          "Error processing OpenAI message:",
          err,
          "Raw message:",
          data
        );
      }
    });

    connection.on("message", (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case "media":
            latestMediaTimestamp = data.media.timestamp;

            if (SHOW_TIMING_MATH) {
              console.log(
                `Received media message with timestamp: ${latestMediaTimestamp}ms`
              );
            }

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

            responseStartTimestampTwilio = null;
            latestMediaTimestamp = 0;
            aiResponseInProgress = false;
            break;

          case "mark":
            if (markQueue.length > 0) markQueue.shift();
            break;

          default:
            console.log("Twilio non-media event:", data.event);
        }
      } catch (err) {
        console.error("Error parsing Twilio message:", err, message);
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
      console.log("Twilio client disconnected");
    });

    openAiWs.on("close", () => {
      console.log("OpenAI realtime socket closed");
    });

    openAiWs.on("error", (error) => {
      console.error("Error in OpenAI WebSocket:", error);
      aiResponseInProgress = false;
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening on port ${PORT}`);
});
