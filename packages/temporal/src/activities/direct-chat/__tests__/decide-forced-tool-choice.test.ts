import { describe, expect, it } from "vitest";
import { decideForcedToolChoice } from "../decide-forced-tool-choice";

/**
 * Pure unit tests for the `toolChoice` selector used by
 * `executeDirectChat`'s `streamText` call. The selector is the single
 * branch that decides between:
 *   - `{ type: "tool", toolName }` (force a specific tool)
 *   - `"auto"`               (let the model pick)
 *   - `undefined`            (no tools registered at all)
 *
 * Two business rules:
 *   1. Only force a tool name that actually exists in `availableTools`.
 *      Forcing an absent name throws a no-tool error from the AI SDK.
 *   2. NEVER force `{type:"tool"}` when Anthropic extended thinking is
 *      enabled — Anthropic's API rejects the combination with HTTP 400
 *      "Thinking may not be enabled when tool_choice forces tool use."
 *      Mirrors the demotion landed for the LangGraph excalidraw agent in
 *      PR #1177 (chat-node.ts) — same constraint, different code path.
 */
describe("decideForcedToolChoice", () => {
	const availableTools = {
		fabric_create_frame: {},
		fabric_create_slideshow: {},
		other_tool: {},
	};

	it("returns undefined when no tools are registered", () => {
		expect(
			decideForcedToolChoice({
				forcedToolName: undefined,
				availableTools: {},
				thinkingEnabled: false,
			}),
		).toBeUndefined();
	});

	it("returns 'auto' when tools are available but no force is requested", () => {
		expect(
			decideForcedToolChoice({
				forcedToolName: undefined,
				availableTools,
				thinkingEnabled: false,
			}),
		).toBe("auto");
	});

	it("forces the named tool when it exists and thinking is off", () => {
		expect(
			decideForcedToolChoice({
				forcedToolName: "fabric_create_frame",
				availableTools,
				thinkingEnabled: false,
			}),
		).toEqual({ type: "tool", toolName: "fabric_create_frame" });
	});

	it("falls back to 'auto' when the forced name is absent from availableTools", () => {
		// AI SDK throws a no-tool error if we force a name that isn't in
		// the tools map. Defensive demotion keeps the request shippable.
		expect(
			decideForcedToolChoice({
				forcedToolName: "fabric_create_frame",
				availableTools: { other_tool: {} },
				thinkingEnabled: false,
			}),
		).toBe("auto");
	});

	it("demotes a forced tool to 'auto' when Anthropic thinking is enabled", () => {
		// The bug this guard prevents: Anthropic returns HTTP 400 when the
		// request has BOTH `providerOptions.anthropic.thinking={type:"enabled"}`
		// AND `tool_choice={type:"tool",name:...}` set. The same fix landed
		// in the LangGraph excalidraw agent (PR #1177, chat-node.ts). Here
		// we apply it symmetrically to the direct-chat Vercel-AI-SDK path.
		expect(
			decideForcedToolChoice({
				forcedToolName: "fabric_create_frame",
				availableTools,
				thinkingEnabled: true,
			}),
		).toBe("auto");
	});

	it("returns undefined when no tools are registered, even if a force is requested", () => {
		// Edge case: caller can't ask to force a tool when there are no
		// tools at all. Don't synthesize an empty force; just skip
		// toolChoice entirely so streamText omits it from the wire body.
		expect(
			decideForcedToolChoice({
				forcedToolName: "fabric_create_frame",
				availableTools: {},
				thinkingEnabled: false,
			}),
		).toBeUndefined();
	});
});
