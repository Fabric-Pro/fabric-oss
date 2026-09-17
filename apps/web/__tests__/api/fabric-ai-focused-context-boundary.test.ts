/**
 * The Fabric AI stream route must keep route-derived project and focused-entity
 * content out of the trusted `systemPrompt`: it travels to the workflow as
 * `projectContext`, which the chat activity wraps as untrusted retrieved
 * context. A poisoned story description or document body must never become a
 * system instruction again (security/direct-chat-untrusted-context).
 *
 * Source-invariant test in the same style as the sibling route tests: the
 * route's module graph (Temporal client, Prisma, auth) is not cheap to import
 * for an invariant check, so this reads the live source.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STREAM_ROUTE_PATH = "app/api/agents/fabric-ai/stream/route.ts";

function readRoute(): string {
	return readFileSync(join(process.cwd(), STREAM_ROUTE_PATH), "utf8");
}

describe("fabric-ai stream route — focused context stays out of systemPrompt", () => {
	it("returns the project/focused context separately from the caller's instructions", () => {
		const source = readRoute();
		const start = source.indexOf(
			"async function buildAgentContextSystemPrompt(",
		);
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("export async function POST(", start);
		const builder = source.slice(start, end);
		// Every return hands back the two halves as separate fields.
		expect(builder).toMatch(
			/return \{\s*systemPrompt: baseSystemPrompt,\s*projectContext: contextBlock \|\| undefined,\s*\}/,
		);
		// The old concatenation must not come back.
		expect(builder).not.toMatch(/\[baseSystemPrompt,\s*contextBlock\]/);
		expect(builder).not.toMatch(/return baseSystemPrompt;/);
	});

	it("passes projectContext to the workflow input as its own field", () => {
		const source = readRoute();
		const handler = source.slice(
			source.indexOf("export async function POST("),
		);
		expect(handler).toMatch(
			/systemPrompt: contextualSystemPrompt,\s*projectContext,/,
		);
		// The workflow input object carries both fields separately.
		expect(source).toMatch(
			/systemPrompt,\s*projectContext,\s*modelOverride,\s*\};/,
		);
	});
});
