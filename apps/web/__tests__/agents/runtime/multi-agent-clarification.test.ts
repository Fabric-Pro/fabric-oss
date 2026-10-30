/**
 * A multi-agent turn never waits on a clarifying question, so the chat's
 * multi-agent mode renders approvals only.
 *
 * Every agent of a multi-agent turn runs with surface "nexus" (asserted in
 * `orchestrator-engine-multi-agent.test.ts`), and the Orchestrator workflow
 * raises a clarification only for the standalone Loom chat's surface: both
 * places that set `pendingClarification` (the up-front check and the
 * per-step check) are gated on `input.surface === "loom-orchestrator"`.
 * Nexus relied on the same gate. If a new clarification path appears, or a
 * gate admits "nexus", this fails and the multi-agent chat must render the
 * clarification card for that agent.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW_DIR = resolve(
	__dirname,
	"../../../../../packages/temporal/src/workflows/orchestrator",
);
const read = (file: string) =>
	readFileSync(resolve(WORKFLOW_DIR, file), "utf8");
const workflow = read("index.ts");
const GATES = ["upfrontClarificationEnabled", "perStepClarificationEnabled"];

/** Each place a file starts waiting on a clarification. */
function clarificationStarts(code: string): number[] {
	return [...code.matchAll(/state\.pendingClarification = \{/g)].map(
		(match) => match.index ?? -1,
	);
}

describe("clarifications in a multi-agent turn", () => {
	it("are gated on the Loom chat's surface", () => {
		for (const gate of GATES) {
			const start = workflow.indexOf(`const ${gate} =`);
			expect(start, gate).toBeGreaterThan(-1);
			expect(
				workflow.slice(start, workflow.indexOf(";", start)),
			).toContain('input.surface === "loom-orchestrator"');
		}
	});

	it("are raised only behind those gates, one each", () => {
		const starts = clarificationStarts(workflow);
		expect(starts).toHaveLength(GATES.length);
		starts.forEach((start, index) => {
			const nearest = GATES.map((gate) => ({
				gate,
				at: workflow.lastIndexOf(`${gate} &&`, start),
			})).sort((a, b) => b.at - a.at)[0];
			expect(nearest?.at).toBeGreaterThan(-1);
			expect(nearest?.gate).toBe(GATES[index]);
		});
	});

	it("are raised nowhere else in the Orchestrator workflow", () => {
		const others = readdirSync(WORKFLOW_DIR, { recursive: true })
			.map(String)
			.filter(
				(file) =>
					file.endsWith(".ts") &&
					file !== "index.ts" &&
					!file.includes("__tests__"),
			);
		expect(others.length).toBeGreaterThan(0);
		for (const file of others) {
			expect(clarificationStarts(read(file)), file).toEqual([]);
		}
	});
});
