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

// --- Hardware knowledge for tech troubleshooting ---
let hardwareKnowledge = {
  hardware: []
};

const HARDWARE_KNOWLEDGE_PATH = "./hardware_knowledge.json";

try {
  const rawHw = fs.readFileSync(HARDWARE_KNOWLEDGE_PATH, "utf8");
  hardwareKnowledge = JSON.parse(rawHw);
  console.log(
    "Loaded hardware_knowledge.json with",
    (hardwareKnowledge.hardware || []).length,
    "items."
  );
} catch (err) {
  console.warn(
    "Could not load hardware_knowledge.json; proceeding with minimal hardware context.",
    err.message
  );
  hardwareKnowledge = { hardware: [] };
}

/**
 * Build a compact hardware snippet for the system message.
 * We only send high-level info so we don't overwhelm the model.
 */
function buildHardwareSnippet() {
  const items = hardwareKnowledge.hardware || [];
  if (!items.length) {
    return "No detailed hardware inventory loaded yet.";
  }

  const summaryLines = [];

  // Group by category, and take a few examples per category.
  const byCategory = {};
  for (const hw of items) {
    const category = hw.category || "other";
    if (!byCategory[category]) byCategory[category] = [];
    byCategory[category].push(hw);
  }

  for (const [category, list] of Object.entries(byCategory)) {
    const examples = list
      .slice(0, 3)
      .map((hw) => `${hw.make} ${hw.model}`)
      .join(", ");
    summaryLines.push(`- ${category}: examples include ${examples}`);
  }

  return `
STREAMOGRAPHY HARDWARE OVERVIEW

You have access to an internal hardware map that includes common categories like cameras,
switchers, graphics/NDI tools, converters, encoders, routers, audio gear, and cables.

High-level examples:
${summaryLines.join("\n")}
`.trim();
}

// --- Technician notes storage (simple JSON log) ---
let technicianNotes = [];
const TECH_NOTES_PATH = "./technician_notes.json";

try {
  const rawNotes = fs.readFileSync(TECH_NOTES_PATH, "utf8");
  technicianNotes = JSON.parse(rawNotes);
  console.log(
    "Loaded technician_notes.json with",
    technicianNotes.length,
    "entries."
  );
} catch (err) {
  console.warn(
    "Could not load technician_notes.json; starting with an empty list.",
    err.message
  );
  technicianNotes = [];
}

function appendTechnicianNote(note) {
  try {
    technicianNotes.push(note);
    fs.writeFileSync(TECH_NOTES_PATH, JSON.stringify(technicianNotes, null, 2));
    console.log("Appended technician note:", note);
  } catch (err) {
    console.error("Failed to append technician note:", err);
  }
}

// --- Senior tech hunt group (hardcoded in order) ---
const seniorTechNumbers = [
  "+19782907750", // Senior Tech 1
  "+17814699310", // Senior Tech 2
  "+19786757031", // Senior Tech 3
  "+19788801917"  // Senior Tech 4
];

const { OPENAI_API_KEY } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.");
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ---- Technician-focused system message ----
const SYSTEM_MESSAGE = `
You are a helpful, friendly, slightly geeky, and professionally conversational AI assistant
for Streamography Productions. You are speaking primarily with STREAMOGRAPHY TECHNICIANS
who are on-site at events and need quick, practical support.

Your job:
- Help technicians troubleshoot livestream, audio, lighting, projection, and recording issues.
- Ask focused, practical questions to understand the setup and symptoms.
- Offer clear, step-by-step suggestions that are safe and realistic in the field.
- Use the company and hardware information below when relevant, but prioritize practical problem-solving.

COMPANY / SERVICE CONTEXT:
${buildKnowledgeSnippet()}

HARDWARE CONTEXT:
${buildHardwareSnippet()}

Personality:
- You sound like a confident, approachable tech nerd who really knows his stuff.
- You enjoy explaining things clearly and simply, without being condescending.
- You’re warm, upbeat, and you genuinely like helping coworkers under pressure.
- Light, nerdy charm or dad-joke energy is okay occasionally, but never overdone.

Voice style:
- Use short, natural sentences.
- Use contractions ("I'm", "you're", "that's", "we'll") whenever they sound natural.
- Sound relaxed, upbeat, slightly geeky, and human, not like a robot reading a script.
- Keep a moderate speaking pace: not rushed, not painfully slow.
- Speak with a warm, smooth tone.
- Avoid sharp or abrupt sentence starts.

Conversation style:
- Assume the technician might be busy, stressed, or under time pressure.
- Keep most answers brief: 1–3 sentences, followed by a clarifying question if needed.
- Ask one clear question at a time.
- Reflect back what the tech is trying to do before giving steps.
  Example: "Gotcha, you're trying to get audio from the mixer into the camera. Let's check a couple things."

Background noise & chatter:
- Assume there may be crowd noise, PA audio, or side conversations near the technician.
- Only respond when it sounds like someone is clearly talking directly to you (full sentences or clear questions).
- Ignore faint background speech, audience reactions, or random noises.
- If you’re not sure they’re talking to you, wait a moment instead of jumping in.

End-of-call behavior:
- If the tech says they’re all set, wrap up with a short, warm closing and stop initiating new topics.

If you are not sure about something:
- Be honest. Say you don't have that exact information.
- Offer a best-effort path, and suggest they escalate to a senior technician if needed.
- When appropriate, say something like:
  "If this still isn’t behaving, you can call back and choose the option to reach a senior technician."
`;

const VOICE = "verse";
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

/**
 * MAIN VOICE ENTRYPOINT
 * This now presents a simple IVR:
 *  - Press 1 → AI tech support (OpenAI Realtime)
 *  - Press 2 → Leave a technician note (recording saved & logged)
 *  - Press 3 → Hunt group to next available senior technician (if configured)
 */
fastify.all("/incoming-call", async (request, reply) => {
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="/menu-selection" timeout="6">
    <Say voice="alice">
      Thanks for calling the Streamography tech line.
      Press 1 for live AI tech support.
      Press 2 to leave a technician note about this event.
      ${
        seniorTechNumbers.length
          ? "Press 3 to be connected to the next available senior technician."
          : ""
      }
    </Say>
  </Gather>
  <!-- If they don't press anything, repeat once and then hang up politely -->
  <Say voice="alice">We didn’t receive any input. Goodbye.</Say>
  <Hangup/>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

/**
 * Handle menu selection from /incoming-call
 */
fastify.all("/menu-selection", async (request, reply) => {
  const digits =
    (request.body && request.body.Digits) || request.query?.Digits || "";
  const host = request.headers.host;

  let twiml;

  if (digits === "1") {
    // AI tech support: connect Twilio Media Stream → /media-stream → OpenAI
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to the Streamography AI tech assistant.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;
  } else if (digits === "2") {
    // Leave technician note (recording)
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    After the tone, describe what happened, what fixed it, or anything future crews should know.
    Press the pound key when you’re done.
  </Say>
  <Record
    action="/handle-tech-note"
    method="POST"
    maxLength="180"
    finishOnKey="#"
    playBeep="true"
  />
  <Say voice="alice">We did not receive a recording. Goodbye.</Say>
  <Hangup/>
</Response>`;
  } else if (digits === "3" && seniorTechNumbers.length) {
    // Hunt group for senior technicians
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you to the next available senior technician.</Say>
  <Redirect method="POST">/call-senior-tech?index=0</Redirect>
</Response>`;
  } else {
    // Invalid choice → back to main menu
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Sorry, that was not a valid option.</Say>
  <Redirect method="POST">/incoming-call</Redirect>
</Response>`;
  }

  reply.type("text/xml").send(twiml);
});

/**
 * Hunt group for senior technicians.
 * - index (query) = which number in the list we're currently trying
 * - DialCallStatus in the POST body tells us if the last attempt connected or not
 */
fastify.all("/call-senior-tech", async (request, reply) => {
  const index = parseInt(request.query?.index || "0", 10) || 0;
  const numbers = seniorTechNumbers;

  if (!numbers.length) {
    const noNumbersTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    We’re currently unable to reach a senior technician. 
    Please press 1 from the main menu for AI support or try again later.
  </Say>
  <Hangup/>
</Response>`;
    reply.type("text/xml").send(noNumbersTwiML);
    return;
  }

  const lastStatus = request.body?.DialCallStatus;

  // If this is a callback from a Dial:
  if (lastStatus) {
    console.log("Hunt group callback status:", lastStatus, "index:", index);

    if (lastStatus === "completed") {
      // Caller already spoke to a senior tech; wrap up.
      const doneTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for speaking with a senior technician. Goodbye.</Say>
  <Hangup/>
</Response>`;
      reply.type("text/xml").send(doneTwiML);
      return;
    }

    // No-answer / busy / failed → try next number if available
    const nextIndex = index + 1;
    if (nextIndex >= numbers.length) {
      const exhaustedTwiML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    We couldn't reach any senior technicians right now.
    Please press 1 from the main menu for AI support or try again later.
  </Say>
  <Hangup/>
</Response>`;
      reply.type("text/xml").send(exhaustedTwiML);
      return;
    }

    // Try the next number in the list
    const nextNumber = numbers[nextIndex];
    console.log("Hunt group: dialing next number:", nextNumber);

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="/call-senior-tech?index=${nextIndex}" method="POST">
    <Number timeout="20">${nextNumber}</Number>
  </Dial>
</Response>`;

    reply.type("text/xml").send(twimlResponse);
    return;
  }

  // First time here: start by dialing numbers[index]
  const currentNumber = numbers[index];
  console.log("Hunt group: starting with number:", currentNumber);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="/call-senior-tech?index=${index}" method="POST">
    <Number timeout="20">${currentNumber}</Number>
  </Dial>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

/**
 * Handle technician note recording callback.
 * Twilio sends RecordingUrl, RecordingDuration, From, CallSid, etc.
 * We store the metadata in technician_notes.json for later review / knowledge updates.
 */
fastify.all("/handle-tech-note", async (request, reply) => {
  const { RecordingUrl, RecordingDuration, From, CallSid } = request.body || {};

  const note = {
    type: "voice",
    timestamp: new Date().toISOString(),
    from: From || null,
    callSid: CallSid || null,
    recordingUrl: RecordingUrl || null,
    recordingDurationSeconds: RecordingDuration
      ? Number(RecordingDuration)
      : null
  };

  appendTechnicianNote(note);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks. Your technician note has been saved. Goodbye.</Say>
  <Hangup/>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

/**
 * SMS entrypoint (same Twilio phone number).
 * Any text message to this number is logged as a technician note.
 */
fastify.all("/incoming-sms", async (request, reply) => {
  const { From, Body } = request.body || {};

  const note = {
    type: "sms",
    timestamp: new Date().toISOString(),
    from: From || null,
    text: Body || ""
  };
  appendTechnicianNote(note);

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>
    Thanks, your note has been saved for future tech support.
    If this is urgent, call the tech line and choose live support.
  </Message>
</Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// ------------------
// OpenAI Realtime bridge
// ------------------
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
              // Less sensitive: require stronger speech / clearer pauses.
              threshold: 0.9,
              silence_duration_ms: 1400,
              prefix_padding_ms: 500
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
                modalities: ["audio", "text"],
                instructions: `${SYSTEM_MESSAGE}

For your first reply, greet the technician in a warm, slightly geeky but professional way,
and briefly ask what they’re working on and what’s going wrong.`
              }
            })
          );
        }, 500); // experiment with 250–600ms
      };

      const handleSpeechStartedEvent = () => {
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
        setTimeout(initializeSession, 100);
      });

      openAiWs.on("message", (data) => {
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
            pendingAudioChunks = [];
            hasFlushedInitialAudio = false;
          }

          if (response.type === "response.done") {
            flushPendingAudio();
            aiResponseInProgress = false;

            if (response.response?.status === "failed") {
              console.error(
                "Response failed details:",
                JSON.stringify(response.response?.status_details, null, 2)
              );
            }
          }

          if (response.type === "response.audio.delta") {
            if (!response.delta) {
              console.warn(
                "response.audio.delta event received without a delta field"
              );
              return;
            }

            if (!streamSid) {
              console.warn(
                "Skipping audio delta because streamSid is not set yet"
              );
              return;
            }

            let audioPayload;
            try {
              const decoded = Buffer.from(response.delta, "base64");
              audioPayload = decoded.toString("base64");
            } catch (e) {
              console.error("Failed to process audio delta base64:", e);
              return;
            }

            if (!hasFlushedInitialAudio) {
              pendingAudioChunks.push(audioPayload);

              if (pendingAudioChunks.length >= INITIAL_CHUNKS_BEFORE_FLUSH) {
                flushPendingAudio();
              }
            } else {
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

              responseStartTimestampTwilio = null;
              latestMediaTimestamp = 0;
              aiResponseInProgress = false;
              markQueue = [];
              lastAssistantItem = null;
              pendingAudioChunks = [];
              hasFlushedInitialAudio = false;

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
