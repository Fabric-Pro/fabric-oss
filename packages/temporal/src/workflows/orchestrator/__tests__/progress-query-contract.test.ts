import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Importing the workflow loads the Temporal sandbox. This query-only expansion
// must remain a pure state projection, with no history-producing commands.
const source = readFileSync(
	join(process.cwd(), "src/workflows/orchestrator/index.ts"),
	"utf-8",
);

describe("orchestrator progress query", () => {
	it("projects routing display metadata without adding commands or mutating workflow state", () => {
		const start = source.indexOf("setHandler(progressQuery,");
		const end = source.indexOf("setHandler(planQuery,", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const handler = source.slice(start, end);
		expect(handler).toContain("...state.currentProgress");
		for (const field of [
			"primaryAgent",
			"confidence",
			"riskLevel",
			"requiredConnections",
			"missingIntegrations",
			"blockedOnConnections",
		]) {
			expect(handler.replace(/\s+/g, "")).toContain(
				`${field}:state.routingDecision.${field}`,
			);
		}
		expect(handler).not.toContain("...state.routingDecision");
		expect(handler).not.toMatch(/state\.\w+\s*=(?!=)/);
		expect(handler).not.toMatch(
			/\b(await|proxyActivities|executeChild|startChild|sleep|Date|Math|fetch|setTimeout)\b/,
		);
	});
});
