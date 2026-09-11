---
"fabric-app": patch
---

Make the meeting transcript lookup reachable from the iterative agent instead of failing as a missing MCP server

Follow-up to the date-aware meeting lookup. Verified on staging against a project holding
Fabric DSU transcripts for 8, 9 and 10 September — all synced and embedded — and the
original symptom was unchanged: asked "do you see any meeting transcripts from September
10, 2026?", the assistant called `project_rag_query`, `search_slack_messages` and
`search_teams_messages`, never the new tool, and answered "no… the most recent being
8/26/2026".

Probing directly showed why. The tool was deployed and advertised — "Yes, I have that
exact tool" — but calling it returned `{"error":"MCP configuration not found. Please
configure your MCP server in Settings."}`.

The iterative orchestrator keeps its own pre-registration list and its own inline tool
dispatch chain, separate from the step handler registry the first change wired. The tool
was in neither, so the model could discover it through `search_tools` but the call then
fell through to MCP resolution and failed — and, never having been pre-registered, it was
not a first-class option, so the model reached for semantic search instead.

- Pre-register the tool in `discoveredTools` alongside `project_rag_query`, with its schema
  and a description that steers date questions away from semantic search, and name it in
  the focused-agent prompt's list of directly-callable tools.
- Add an explicit dispatch branch so the call executes instead of falling through to MCP.
- Route it through a new `listMeetingTranscriptsActivity`, because a workflow must not
  reach the database directly. It throws on failure rather than returning an empty list:
  "no transcripts" and "the lookup broke" must never look alike to the model, which is the
  entire point of the tool.

Worth remembering for the next tool: registered is not the same as reachable. There are
three dispatch surfaces plus a client-side id allowlist, and partial registration looks
exactly like complete registration until the real surface is exercised.

Two corrections to the above, both caught by CI rather than by local gates:

- The activity was exported from the orchestrator sub-barrel but not from the top-level
  `activities/index.ts` the worker registers, whose re-exports are explicit named blocks
  rather than `export *`. The name never propagated, so the tool would have been
  dispatchable but not executable — "Activity function is not registered on this Worker",
  the same reachability failure one level further down.
- The new dispatch branch is patch-gated. An earlier claim that existing histories were
  unaffected because the branch only fires for a call that could not previously be
  dispatched was wrong: the call *was* dispatchable, it just failed. Those runs reached
  the MCP arm and recorded its `loom-mcp-tool-call-ceiling-v1` marker, so replaying them
  against an ungated branch stops short of the marker and fails TMPRL1100.
