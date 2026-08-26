import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for Codex pass #1 concern #6 — "every Command.update site in
 * project-document-generator chat-node.ts must spread reasoningByTurnUpdate".
 *
 * The fully-driven chat-node graph is hard to unit-test against every branch
 * (deep tool-routing + buildConfirmChangesCommand pre-stream validation). The
 * spread itself is a pure source-shape contract: a single
 * `reasoningByTurnUpdate` variable computed once, spread into every
 * Command.update return path (or into buildConfirmChangesCommand's
 * `extraStateUpdate` for the two tool-success paths).
 *
 * This test asserts that source shape directly. It is intentionally a textual
 * regression guard — its sole job is to fire if a future refactor silently
 * drops one of the spreads.
 *
 * Sites:
 *   A) buildConfirmChangesCommand extraStateUpdate, write tool path
 *   B) buildConfirmChangesCommand extraStateUpdate, patch tool path
 *   C) Command.update (no goto, external tool routing fallback).
 *      The synthesized ask_clarifying_question tool call is injected onto the model
 *      response upstream of routing, so it flows through THIS external-tool site.
 *   D) Command.update (goto: END, no tool call fallback)
 *   E) Command.update (goto: END, model-initiated bare confirm_changes intercepted) —
 *      the run ends with a plain reply, and the turn's reasoning trace still flows.
 *   F) Command.update (goto: END, empty truncated response after the escalated
 *      retry — issue #2976). The run failed, but the turn still produced a
 *      reasoning trace: that trace is the only record of what the model spent
 *      its entire output budget on, so it must reach the UI with the error.
 *   G) Command.update (goto: END, the finalize guard's terminal fallback
 *      returned nothing but a research call that had to be stripped — issue
 *      #2999). Also a failed run that still produced a trace, and the trace is
 *      what shows the model reasoning its way into more research instead of
 *      writing.
 */

const CHAT_NODE_PATH = join(__dirname, "..", "nodes", "chat-node.ts");

describe("chat-node — reasoningByTurnUpdate spread regression guard", () => {
	const source = readFileSync(CHAT_NODE_PATH, "utf-8");

	// Two call sites, one resulting variable. The second exists only because the
	// truncation-recovery retry (issue #2976) REPLACES `response`: the failed
	// attempt's reasoning has to be extracted before that, or the trace of what
	// the model spent its whole output budget on is lost. The main capture then
	// coalesces the two. Anything beyond these two is the duplicate-emission
	// hazard this guard was written for.
	it("computes reasoningByTurnUpdate via exactly two buildReasoningUpdate(...) calls (main + pre-retry carry-over)", () => {
		const callMatches = source.match(/buildReasoningUpdate\(/g) ?? [];
		expect(callMatches.length).toBe(2);
	});

	it("spreads reasoningByTurnUpdate at exactly 7 sites (A–G)", () => {
		const spreadMatches =
			source.match(/\.\.\.reasoningByTurnUpdate\b/g) ?? [];
		expect(spreadMatches.length).toBe(7);
	});

	it("calls stripRawResponseEnvelope after buildReasoningUpdate (protocol P1)", () => {
		const buildIdx = source.indexOf("buildReasoningUpdate(");
		const stripIdx = source.indexOf("stripRawResponseEnvelope(");
		expect(buildIdx).toBeGreaterThanOrEqual(0);
		expect(stripIdx).toBeGreaterThan(buildIdx);
	});

	it("captures turnStart = Date.now() BEFORE model.invoke (protocol P3)", () => {
		// Locate the first turnStart capture and the first modelWithTools.invoke
		// after it; turnStart MUST come first.
		const turnStartIdx = source.indexOf("const turnStart = Date.now()");
		const invokeIdx = source.indexOf(
			"modelWithTools.invoke(",
			turnStartIdx,
		);
		expect(turnStartIdx).toBeGreaterThanOrEqual(0);
		expect(invokeIdx).toBeGreaterThan(turnStartIdx);
	});

	it("imports reasoning helpers from @repo/agent-core/reasoning-trace (no in-tree extract import)", () => {
		expect(source).toMatch(/from\s+"@repo\/agent-core\/reasoning-trace"/);
		// The shim file still exists for back-compat, but chat-node itself must
		// not import from it any more — that would defeat the migration.
		expect(source).not.toMatch(/from\s+"\.\/chat-node-reasoning"/);
	});
});
