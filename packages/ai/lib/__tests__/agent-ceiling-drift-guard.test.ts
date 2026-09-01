/**
 * Drift guard: the fallback ceiling must equal the agent's ordinary-turn ceiling.
 *
 * The document-generation fallback stands in for the LangGraph generator when
 * that service cannot be reached. If the fallback asks for a smaller output
 * budget than the agent applies to itself, an outage silently becomes a
 * truncated document instead of a failure — which is how Fizzy #2210 presented:
 * an error blaming document size for a dependency that was never reached.
 *
 * The obvious fix — import the constant — is not available. The agent lives in
 * `agents/langchain/`, which is not a workspace package and is deployed as a
 * separate service; `packages/ai` declares no dependency on it and must not.
 * So the value is duplicated deliberately and this guard reads the agent's
 * source to prove the copies agree. It fails on divergence rather than letting
 * two independently-editable ceilings drift apart, which is the same defect
 * class as the two feature flags this ticket removed.
 *
 * If this test fails, the two numbers disagree. Decide which is correct and
 * change BOTH — do not relax the assertion.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_GENERATION_FALLBACK_CEILING } from "../output-token-budget";

const AGENT_CHAT_NODE = join(
	__dirname,
	"../../../../agents/langchain/project-document-generator/nodes/chat-node.ts",
);

/** `const NORMAL_OUTPUT_TOKEN_CEILING = 48_000;` — underscores optional. */
const CEILING_DECLARATION =
	/const\s+NORMAL_OUTPUT_TOKEN_CEILING\s*=\s*([0-9_]+)\s*;/;

describe("document-generation fallback ceiling", () => {
	it("matches the generation agent's ordinary-turn ceiling", () => {
		const source = readFileSync(AGENT_CHAT_NODE, "utf8");
		const match = source.match(CEILING_DECLARATION);

		// A rename or a move is itself drift: the guard cannot prove agreement it
		// cannot read, and silently passing would restore the exact blind spot
		// this file exists to close.
		expect(
			match,
			`NORMAL_OUTPUT_TOKEN_CEILING not found in ${AGENT_CHAT_NODE}. If the agent renamed or moved it, update this guard — do not delete it.`,
		).not.toBeNull();

		const agentCeiling = Number.parseInt(
			(match as RegExpMatchArray)[1].replace(/_/g, ""),
			10,
		);

		expect(agentCeiling).toBe(DOCUMENT_GENERATION_FALLBACK_CEILING);
	});

	// The agent also carries a larger truncation-recovery ceiling for its own
	// retry. Matching THAT would triple the quota this fallback reserves on
	// providers that admit against the requested max_tokens, so the guard pins
	// the ordinary-turn value specifically.
	it("does not silently adopt the agent's truncation-recovery ceiling", () => {
		const source = readFileSync(AGENT_CHAT_NODE, "utf8");
		const retry = source.match(
			/const\s+TRUNCATION_RETRY_OUTPUT_TOKEN_CEILING\s*=\s*([0-9_]+)\s*;/,
		);

		if (retry) {
			const retryCeiling = Number.parseInt(
				retry[1].replace(/_/g, ""),
				10,
			);
			expect(DOCUMENT_GENERATION_FALLBACK_CEILING).not.toBe(retryCeiling);
		}
	});
});
