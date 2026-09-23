/**
 * Every gate the registry can produce survives the procedure's output schema.
 *
 * An oRPC `.output()` schema is enforced at the edge: a remedy or surface the
 * rules produce but the schema does not list fails validation, and the whole
 * matrix answers a 500 rather than one gate going missing. The rule types and
 * the zod enums are written separately, so nothing else joins them.
 */

import { describe, expect, it } from "vitest";
import { getCapabilityGatesProcedure } from "../procedures/get";
import { CAPABILITY_RULES } from "../registry";
import { resolveGate } from "../resolve";
import { evidenceWith, runningJob } from "./evidence-fixture";

const NOW = new Date("2026-09-18T12:00:00.000Z");

interface Schema {
	parse: (value: unknown) => unknown;
}

function schemas() {
	return (
		getCapabilityGatesProcedure as unknown as {
			"~orpc": { inputSchema: Schema; outputSchema: Schema };
		}
	)["~orpc"];
}

/** Evidence that drives every rule to a non-available answer it can give. */
const SHAPES = [
	evidenceWith({}),
	evidenceWith({
		codebase: {
			connected: false,
			usable: false,
			healthy: false,
			integrationStatus: null,
		},
		context: { total: 0, technical: 0, product: 0 },
		documents: { usableTypes: new Set<string>() },
		descriptionLength: 0,
		pm: {
			bulkTargetResolvable: false,
			itemConfigResolvable: false,
			boardSelected: false,
		},
		roadmap: { itemCount: 0 },
		aiRecommended: { eligibleBatchCount: 0 },
		chat: { linkedChannelCount: 0 },
	}),
	evidenceWith({ pm: { boardSelected: false } }),
	evidenceWith({ pm: { readOnly: true } }),
	evidenceWith({
		pm: { syncing: runningJob(new Date(NOW.getTime() - 60_000)) },
	}),
];

describe("capability gates output schema", () => {
	it("accepts every gate every rule resolves to", () => {
		const gates = SHAPES.flatMap((evidence) =>
			CAPABILITY_RULES.map((rule) => resolveGate(rule, evidence, NOW)),
		);

		expect(() =>
			schemas().outputSchema.parse({ enabled: true, gates }),
		).not.toThrow();
	});

	it("carries a board remedy on a Roadmap pull gate through intact", () => {
		const rule = CAPABILITY_RULES.find(
			(r) => r.key === "roadmap.pull-from-pm",
		);
		if (!rule) {
			throw new Error("No rule registered for roadmap.pull-from-pm");
		}
		const gate = resolveGate(rule, SHAPES[2], NOW);

		const parsed = schemas().outputSchema.parse({
			enabled: true,
			gates: [gate],
		}) as { gates: Array<{ remedy: unknown }> };

		expect(parsed.gates[0].remedy).toBe("CONFIGURE_PM_BOARD");
	});

	it("lets a page ask for the roadmap surface", () => {
		const parsed = schemas().inputSchema.parse({
			projectId: "project_example",
			surface: "roadmap",
		}) as { surface?: unknown };

		expect(parsed.surface).toBe("roadmap");
	});
});
