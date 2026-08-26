/**
 * Guards the fix for issue #2269: three POST SSE-streaming routes poll
 * Temporal for progress with internal deadlines at or above Vercel's default
 * 300s function budget, but shipped with no `maxDuration` export — the
 * platform hard-killed them mid-stream ("Task timed out after 300 seconds")
 * before their own graceful timeout paths (the "Workflow timed out" /
 * "Execution timed out" SSE events) could run. Sibling precedent: PR #2270
 * pinned `maxDuration` on the realtime SSE routes with the same
 * deadline-plus-headroom pattern.
 *
 * `route.ts`'s `export const maxDuration` must stay a static numeric literal
 * — Next.js route segment config is statically analyzed and can't import a
 * value (see the note in apps/web/app/api/copilotkit/config.ts) — so this
 * reads the live source and checks the invariant by regex instead of
 * importing it, mirroring copilotkit-token-ttl-drift.test.ts. The route
 * modules themselves pull in Temporal/database and aren't cheap to import
 * for a pure config check.
 *
 * For fabric-ai/stream and workflow-templates/stream, the pre-poll work
 * (auth, body parsing, access checks, Temporal connect) is seconds, so the
 * poll deadline (MAX_POLL_DURATION) is a good proxy for total request time.
 * orchestrator-temporal/stream is different: it can await a RAG
 * sub-workflow (`workflowExecutionTimeout: "2m"`) BEFORE its poll loop
 * starts, so its deadline constant (MAX_STREAM_DURATION) is anchored at
 * request entry instead of at the poll loop, and already covers that
 * pre-work — see `requestStartedAt` in that route.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_DURATION_PATTERN = /^export const maxDuration = (\d+);/m;

// Graceful-path headroom: how much slack maxDuration must leave above the
// route's internal deadline so the "timed out" SSE event can actually be
// delivered and the stream closed before the platform's hard kill.
const GRACEFUL_HEADROOM_MS = 30_000;

// Vercel plan ceiling — a maxDuration above this fails the build.
const VERCEL_MAX_DURATION_CEILING = 800;

function readRouteSource(relativeRoutePath: string): string {
	return readFileSync(join(process.cwd(), relativeRoutePath), "utf-8");
}

function extractSingleMatch(
	source: string,
	pattern: RegExp,
	label: string,
): number {
	const matches = [...source.matchAll(new RegExp(pattern, "gm"))];
	expect(matches, `expected exactly one match of ${label}`).toHaveLength(1);
	return Number(matches[0][1]);
}

describe.each([
	{
		name: "fabric-ai/stream",
		routePath: "app/api/agents/fabric-ai/stream/route.ts",
		deadlinePattern: /MAX_POLL_DURATION = (\d+)/,
		deadlineLabel: "MAX_POLL_DURATION",
	},
	{
		name: "orchestrator-temporal/stream",
		routePath:
			"app/api/agents/fabric-ai/orchestrator-temporal/stream/route.ts",
		deadlinePattern: /MAX_STREAM_DURATION = (\d+)/,
		deadlineLabel: "MAX_STREAM_DURATION",
	},
	{
		name: "workflow-templates/stream",
		routePath: "app/api/agents/workflow-templates/stream/route.ts",
		deadlinePattern: /MAX_POLL_DURATION = (\d+)/,
		deadlineLabel: "MAX_POLL_DURATION",
	},
])(
	"$name maxDuration vs. internal deadline",
	({ routePath, deadlinePattern, deadlineLabel }) => {
		it("exports one static maxDuration literal with enough headroom over its deadline constant", () => {
			const source = readRouteSource(routePath);

			const maxDurationSeconds = extractSingleMatch(
				source,
				MAX_DURATION_PATTERN,
				"export const maxDuration = <n>;",
			);
			const deadlineMs = extractSingleMatch(
				source,
				deadlinePattern,
				deadlineLabel,
			);

			expect(maxDurationSeconds * 1000).toBeGreaterThanOrEqual(
				deadlineMs + GRACEFUL_HEADROOM_MS,
			);
			expect(maxDurationSeconds).toBeLessThanOrEqual(
				VERCEL_MAX_DURATION_CEILING,
			);
		});
	},
);
