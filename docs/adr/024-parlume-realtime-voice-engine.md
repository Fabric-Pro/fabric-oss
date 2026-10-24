# ADR-024: Parlume speaks through a realtime speech-to-speech session, with the cascade as fallback

Parlume's meeting voice moves from a transcribe, agent, synthesize cascade to an OpenAI Realtime session that hands Fabric work to the agent in the background.

- **Audience**: Platform and AI engineers working on Parlume
- **Owner**: Engineering team
- **Status**: Accepted
- **Date**: 2026-10-23
- **Deciders**: Engineering team

## Context

Parlume answered a spoken question through a cascade. The bridge (a Cloudflare
Durable Object) transcribed the mixed meeting audio with Deepgram Flux on
Workers AI, waited for the end of the speaker's turn, handed the request to a
Temporal meeting turn that ran the selected Fabric agent, and spoke the answer
with text-to-speech. Each stage waited for the one before it.

Measured on staging on 2026-10-15, a warm reply took about 11 seconds from the
end of the question to the first audio:

- Flux end of turn: about 2 s
- the quiet window after it: 0.6 s
- hand-off to Fabric: 0.16 s warm, 2.8 s cold
- the agent turn: about 5 s, of which the model call alone was 2 to 3.7 s
  because the prompt carried about 25,000 input tokens
- speech synthesis through the gateway: 2 to 3.4 s, returned as a whole clip

Later work on the cascade (sentence-at-a-time speech, the Aura voice streamed
from the bridge, a leaner prompt) shortened some stages, but the structure
stayed serial: nothing could be said until transcription, the agent and the
first sentence's synthesis had each finished.

Two other problems came from the same structure. The transcript is the only
thing the agent hears, so a misrecognized word ("Fabrik", "Parloom",
"Perlman") or a clipped question became a wrong request. And the meeting had to
wait in silence while Fabric worked: the voice had no way to acknowledge a
question, take a follow-up, or keep talking while a lookup ran, because the
voice and the agent were the same turn.

## Decision

When the inviter's organization has an OpenAI Direct key, Parlume talks through
an OpenAI Realtime speech-to-speech session (`gpt-realtime-2.1`). The cascade
stays as the automatic fallback.

- **Session and credential.** Once the meeting stream is verified, the bridge
  asks `/api/internal/parlume/realtime-session` once. The web API checks that the
  session is live and the inviter still has project access, resolves the
  organization's OpenAI key, and mints a short-lived client secret
  (`POST /v1/realtime/client_secrets`) whose session carries the instructions,
  the tools and the audio settings. The key never leaves the web API; the
  bridge holds only the secret. The instructions are the bindable **Parlume
  Realtime Voice** prompt (`parlume_realtime_voice`), followed by the project
  name, whether changes are allowed and who has spoken, fenced as meeting data.
- **Transport.** The Durable Object opens the session's WebSocket itself and
  streams all meeting audio into it, resampled from 16 kHz to 24 kHz in 100 ms
  appends. Replies play through the same audio outlet as the cascade's voice.
- **Listens continuously, replies on request.** Server voice activity detection
  (`semantic_vad`) reports speech start and stop, but `create_response` and
  `interrupt_response` are off, so the model never answers on its own. The bridge
  sends `response.create` only when someone says a wake phrase and stops
  talking, when a chat message asks for a spoken answer, when a chat post is to
  be read aloud, or when a Fabric job has a result. Flux keeps running on the
  same audio for the transcript, speaker attribution, wake detection and notes.
- **Fabric work is an asynchronous job.** The session has three tools.
  `ask_fabric({ request })` starts an ordinary meeting turn
  (`/api/internal/parlume/turns` with `delivery: "realtime"` and a job number),
  with the same agent, actions policy, audit, receipts and history as any other
  request, and returns `{ status: "started", job }` at once, so the voice says a
  holding line and the conversation continues. The worker runs the agent without
  speaking, posts a long answer to the chat, and sends the answer to the bridge,
  which adds it to the conversation as that job's result and has the voice say
  it. One job runs at a time. `post_to_chat` and `read_chat` use the bridge's
  tagged, delivery-confirmed chat channel. The session itself cannot change
  anything in Fabric.
- **One voice floor for both engines.** Playback state, barge-in decisions,
  interrupts and mutes live in a shared voice floor
  (`party-cf/src/parlume-voice-floor.ts`) that the realtime engine and the
  cascade both use, so the barge-in rules are the same for each.
- **Mute versus cancel.** Speech that wants the floor mutes Parlume. For the
  realtime voice, mute cancels the response in progress
  (`response.cancel`), truncates the assistant's audio item to what the meeting
  actually heard (`conversation.item.truncate`), and leaves any running Fabric
  job alone. A cancel phrase, a new wake phrase or `stop` in the chat cancels:
  it ends the response and the running job, as
  `/api/internal/parlume/interrupt` does for the cascade.
- **Fallback.** No key, a refused mint, or a socket that will not open keeps the
  meeting on the cascade (`parlume.bridge.engine` records the engine and the
  reason). OpenAI ends a Realtime session after 60 minutes, so at 55 minutes, at
  the first quiet moment, the bridge opens a new session with a fresh secret,
  seeds it with the last 40 transcript lines, and closes the old one. An
  unexpected close is retried after 1, 3 and 10 seconds; after that the meeting
  stays on the cascade.
- **Usage.** Each `response.done` is reported to
  `/api/internal/parlume/realtime-usage` and recorded as `OPENAI_DIRECT` usage
  under the `parlume` feature key, priced by modality and cache.

## Alternatives Considered

- **Tune the cascade only.** A leaner prompt, streamed speech and a lower Flux
  end-of-turn threshold each shorten one stage, and some of that work shipped.
  None of it removes the serial structure or the silent wait while the agent
  runs, and none of it helps with misrecognition, because the agent still hears
  only the transcript. Kept as the fallback rather than the primary path.
- **Gemini Live.** A comparable speech-to-speech service. It would add a second
  vendor's credential path, tool-call protocol and pricing, while the OpenAI
  Direct key is already a credential organizations configure in Fabric and the
  cascade's speech fallback uses. Not pursued for the first realtime engine.
- **A full-duplex GPT-Live model.** A model that talks and listens at the same
  time and takes turns on its own fits a one-to-one call. In a multi-party
  meeting Parlume must stay silent until it is addressed, which is why the
  chosen session has automatic responses switched off and the bridge decides
  when to reply.
- **Deepgram Voice Agent.** A hosted agent loop with its own turn-taking and
  function calling. It would take over the parts Parlume needs to control,
  deciding when to answer and running the Fabric agent, rather than the parts
  that were slow.
- **OpenAI Realtime through the Vercel AI Gateway.** Would reuse the gateway
  credential and billing, but its realtime sessions are capped at 25 minutes,
  which would force a mid-meeting reconnect every 25 minutes instead of about
  once an hour.
- **Per-participant audio.** Separate audio per speaker would make attribution
  and barge-in exact. Teams gives the bot mixed audio with dominant-speaker
  attribution that settles only after about 2 seconds, so Parlume keeps the
  mixed stream and attributes turns from the provider's speaker events.

## Consequences

- **Cost.** The meeting's audio streams into the session continuously but is
  billed only when a response reads it, so the responses' usage is the whole
  bill. At about 10 input audio tokens per second, an hour of meeting audio heard
  once costs about $1.15 at list prices; with prompt caching on the rereads and a
  few minutes of spoken answers, an hour of meeting comes to roughly $1.70. If
  caching misses, every response rereads the session's audio at the full input
  rate, and the cost grows with the number of responses in a long meeting.
  The per-session spend on the Parlume page is the check.
- **Session lifetime.** Every meeting longer than 55 minutes rotates the session
  at least once. The new session starts from a 40-line transcript summary rather
  than the full conversation, so very early context can be lost.
- **Interruptions are not instant.** The meeting provider cannot drop audio it
  has already queued, so a muted or cancelled reply stops within about 200 ms
  rather than at once, and the truncation point is computed from the bytes the
  outlet sent.
- **Two engines to maintain.** The cascade stays in production as the fallback
  and for organizations without an OpenAI key. The shared voice floor keeps
  barge-in behavior in one place, but each engine's delivery path needs its own
  tests.
- **Needs live verification.** The cost estimate, live response latency,
  barge-in behavior in a real meeting, and whether the Workers runtime passes the
  WebSocket upgrade's authorization (the secret is sent both as a bearer header
  and as the `openai-insecure-api-key` subprotocol) have not been verified in a
  meeting.
