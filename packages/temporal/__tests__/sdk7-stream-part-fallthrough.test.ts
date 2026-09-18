/**
 * AI SDK 7 widened the `TextStreamPart` union that `streamText().stream`
 * emits: `reasoning-file`, `tool-input-end`, `tool-approval-request`,
 * `tool-approval-response`, `tool-output-denied`, `start`, `start-step`,
 * `abort` and `raw` all arrive at consumers that were written against the v6
 * union. None of this repository's hand-parsed loops is exhaustive over the
 * union (they switch on `part.type` through structural casts), so an
 * unrecognised part must fall through to a branch that does nothing rather
 * than to whatever branch happens to be last.
 *
 * Two of the five loops are covered behaviourally, with fixtures that feed a
 * v7-shaped stream containing parts the loop does not handle:
 *   - `consumeStream` — `report-stream-consume.test.ts`
 *     ("ignores v7 stream parts it does not handle [SDK7]")
 *   - `runAgentIteration` — `run-agent-iteration.dropped-tool-call.test.ts`
 *     ("ignores v7 stream parts the loop does not handle [SDK7]")
 *
 * The other three loops live inside activity functions that pull in the AI
 * SDK, the database, agent-core and the Temporal activity context, and have
 * no existing test harness that drives them. Following the precedent of
 * `mcp-tool-timeout-wiring.test.ts` and `allow-system-in-messages-wiring.ts`,
 * this reads those files as source and pins the two properties that matter:
 * the loop reads the v7 `stream` property, and its part dispatch ends in an
 * explicit do-nothing branch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf-8");
}

/**
 * The text between `for await (const part of <iterable>) {` and the matching
 * closing brace, found by counting braces so a nested block cannot end the
 * slice early.
 */
function streamLoopBody(src: string, iterable: string): string {
	const header = `for await (const part of ${iterable}) {`;
	const start = src.indexOf(header);
	expect(start, `loop over ${iterable} not found`).toBeGreaterThanOrEqual(0);

	let depth = 0;
	for (let i = start + header.length - 1; i < src.length; i++) {
		if (src[i] === "{") {
			depth++;
		} else if (src[i] === "}") {
			depth--;
			if (depth === 0) {
				return src.slice(start, i + 1);
			}
		}
	}
	throw new Error(`unterminated loop over ${iterable}`);
}

/** Strip `// …` line comments so an empty branch reads as empty. */
function stripLineComments(block: string): string {
	return block.replace(/^[ \t]*\/\/.*$/gm, "");
}

const CONSUMERS: Array<{ name: string; path: string; iterable: string }> = [
	{
		name: "direct-chat/ai-execution.ts",
		path: "src/activities/direct-chat/ai-execution.ts",
		iterable: "result.stream",
	},
	{
		name: "orchestrator/.../handlers/mcp-tool-handler.ts",
		path: "src/activities/orchestrator/execution/handlers/mcp-tool-handler.ts",
		iterable: "result.stream",
	},
	{
		name: "template-instance/report-agent-loop.ts",
		path: "src/activities/template-instance/report-agent-loop.ts",
		iterable: "stream.stream",
	},
	{
		name: "orchestrator/execution/run-agent-iteration.ts",
		path: "src/activities/orchestrator/execution/run-agent-iteration.ts",
		iterable: "stream.stream",
	},
];

describe("AI SDK 7 — hand-parsed stream consumers", () => {
	for (const consumer of CONSUMERS) {
		it(`${consumer.name} iterates the v7 \`stream\` property, not \`fullStream\``, () => {
			const src = source(consumer.path);
			// Throws if the loop header is absent, which is the assertion.
			streamLoopBody(src, consumer.iterable);
			expect(src).not.toMatch(
				/for await \(const part of [^)]*fullStream/,
			);
		});

		it(`${consumer.name} ends its part dispatch in an explicit do-nothing branch`, () => {
			const body = stripLineComments(
				streamLoopBody(source(consumer.path), consumer.iterable),
			);
			// Either a trailing `} else { }` on an if-chain, or a `default:`
			// arm whose only statement is `break;`. Both mean: a part type the
			// loop does not recognise changes nothing.
			const emptyElse = /\}\s*else\s*\{\s*\}/.test(body);
			const emptyDefault = /default:\s*break;/.test(body);
			expect(
				emptyElse || emptyDefault,
				"no empty trailing else / default arm found",
			).toBe(true);
		});
	}

	it("agent-executor.ts guards onChunk before doing any work", () => {
		// `onChunk` is the agent executor's equivalent of a stream loop. In
		// v7 it fires for EVERY TextStreamPart; in v6 it saw only a subset.
		// The handler must therefore bail on anything that is not a non-empty
		// text delta before it logs or publishes.
		const src = source(
			"src/activities/agent-execution-core/agent-executor.ts",
		);
		expect(src).toContain(
			'if (chunk.type !== "text-delta" || !chunk.text) {',
		);
	});
});
