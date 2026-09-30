# Parlume meeting preview

Parlume is a default-off, project-scoped way to invite the built-in Fabric Agent or a project-bound custom agent to a Microsoft Teams meeting by link. The control is in the project's Meeting Digest for project administrators. The bot appears as **Fabric Parlume (AI recording)**, transcribes final speech segments, responds to “Hey Fabric,” and saves a transcript and generated notes to the project. The join URL is sent to the meeting provider but is not stored in Fabric.

## Operator setup

1. Deploy the database migration and the updated web API, Temporal worker, and Cloudflare PartyServer/Durable Object together. The Durable Object is event-driven; no dedicated media process runs while there is no meeting.
2. Configure `PARLUME_MEETING_BAAS_API_KEY` in the web API. Fabric derives the public bridge URL from `NEXT_PUBLIC_PARTYKIT_HOST` and the callback URL from `APP_URL` (or `NEXT_PUBLIC_SITE_URL`). `PARLUME_BRIDGE_WS_URL` and `PARLUME_CALLBACK_URL` remain optional explicit overrides. The existing `AGENT_SERVICE_SECRET` must match between web, Temporal, and PartyServer, and PartyServer needs `FABRIC_API_URL` for the internal callback routes.
3. Ensure the Temporal worker's `NEXT_PUBLIC_PARTYKIT_HOST` points at the same PartyServer host. Fabric needs a tenant or platform OpenAI Direct key for PCM speech synthesis. The invite fails before starting a provider bot if the Meeting BaaS key or voice key is unavailable.
4. Enable `PARLUME_MEETINGS` for the test organization. It defaults off. The default choice is **Fabric Agent — this project**, which uses the project's current knowledge and Fabric Agent behavior. Custom agents remain available when owned by the inviter and bound to the project through `project-context`.
5. Paste an ordinary Teams meeting link. The bot joins as an anonymous external guest. The organizer may have to admit it from the lobby. A meeting that requires signed-in or tenant-only guests cannot be joined through this preview without changing that meeting's policy.

For a smoke test, use a disposable meeting with consenting participants. Confirm the bot joins, appears with the recording label, captures final segments, answers “Hey Fabric” aloud, stops on request, and leaves a project transcript and notes. Check that a flagged-off organization cannot invoke the API. The current implementation has not had a live Teams/Meeting BaaS test.

## Boundaries

- The inviter must have project administration permission. Any attendee able to speak in the meeting can request a spoken answer from the selected project's knowledge; the bot cannot verify each attendee's Fabric identity.
- The built-in agent uses the shared Fabric Agent identity and the inviter's current model selection within the organization. Custom agents use the selected version's instructions and model. Both use project RAG and project-bound context. User and agent memory, episodes, and workspace knowledge are excluded. External MCP/OAuth tools and content-changing actions are disabled in this preview. A later release needs an authenticated participant and per-action approval flow before those tools can be exposed.
- Interruption stops queued playback when live transcription identifies a speaker other than the Parlume bot, including an unknown speaker. Unknown segments can still contain bot echo, so barge-in is best-effort.
- Full transcript text is retained as project context and notes are generated asynchronously. Meeting BaaS artifacts are deleted after finalization when its API succeeds. Failed cleanup is left visible for operator recovery.
- The hard stop is four hours; a provider bot can incur charges while waiting in a lobby. Meeting BaaS, live transcription, speech synthesis, and the agent's configured model accrue costs only during meeting work.

Provider references: [Teams guest join restrictions](https://docs.meetingbaas.com/api-v2/authenticated-bots/teams), [streaming audio and transcription](https://docs.meetingbaas.com/api-v2/streaming), [provider pricing](https://www.meetingbaas.com/en/pricing), [OpenAI speech PCM format](https://developers.openai.com/api/docs/guides/text-to-speech).
