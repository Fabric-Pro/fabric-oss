/**
 * Every gate the registry can produce survives the procedure's output schema.
 *
 * An oRPC `.output()` schema is enforced at the edge: a remedy or surface the
 * rules produce but the schema does not list fails validation, and the whole
 * matrix answers a 500 rather than one gate going missing. The rule types and
 * the zod enums are written separately, so nothing else joins them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCapabilityGatesProcedure } from "../procedures/get";
import { CAPABILITY_RULES } from "../registry";
import { resolveGate } from "../resolve";
import { evidenceWith, runningJob } from "./evidence-fixture";

const NOW = new Date("2026-09-18T12:00:00.000Z");

const { mockGather, mockWarn, mockPreference } = vi.hoisted(() => ({
	mockGather: vi.fn(),
	mockWarn: vi.fn(),
	mockPreference: vi.fn(),
}));

// The handler's own collaborators, for the test that runs it. The schema tests
// below read the real procedure and the real rules, which these leave alone.
// Spread, not replaced: importing the procedure pulls in the oRPC stack, which
// reaches other exports of both packages.
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: { projectUserPreference: { findUnique: mockPreference } },
}));
vi.mock("@repo/logs", async (importOriginal) => {
	const actual = await importOriginal<{ logger: Record<string, unknown> }>();
	return { ...actual, logger: { ...actual.logger, warn: mockWarn } };
});
vi.mock("../flag", () => ({
	isCapabilityGatingEnabled: async () => true,
}));
vi.mock("../evidence", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	gatherCapabilityEvidence: (...args: unknown[]) => mockGather(...args),
}));

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

	it("keeps the named subjects of a stalled source, which the schema would otherwise strip", () => {
		const rule = CAPABILITY_RULES.find(
			(r) => r.key === "context.use-linked-source",
		);
		if (!rule) {
			throw new Error("No rule registered for context.use-linked-source");
		}
		const gate = resolveGate(
			rule,
			evidenceWith({
				context: {
					processing: runningJob(
						new Date(NOW.getTime() - 60 * 60 * 1000),
					),
					stalledSources: [
						{ id: "context_stuck", label: "Example brief.pdf" },
					],
					stalledTotal: 4,
				},
			}),
			NOW,
		);

		const parsed = schemas().outputSchema.parse({
			enabled: true,
			gates: [gate],
		}) as {
			gates: Array<{
				subjects: Array<{ id: string; label: string }>;
				subjectTotal: number;
			}>;
		};

		expect(parsed.gates[0].subjects).toEqual([
			{ id: "context_stuck", label: "Example brief.pdf" },
		]);
		expect(parsed.gates[0].subjectTotal).toBe(4);
	});

	it("lets a page ask for the roadmap surface", () => {
		const parsed = schemas().inputSchema.parse({
			projectId: "project_example",
			surface: "roadmap",
		}) as { surface?: unknown };

		expect(parsed.surface).toBe("roadmap");
	});
});

describe("a stall with no source to name", () => {
	type Handler = (opts: unknown) => Promise<{
		gates: Array<{ reasonKey: string | null; subjects: unknown[] }>;
	}>;
	const handler = (
		getCapabilityGatesProcedure as unknown as {
			"~orpc": { handler: Handler };
		}
	)["~orpc"].handler;
	const run = () =>
		handler({
			input: { projectId: "project_example", surface: "context" },
			context: { user: { id: "user_example" }, session: {} },
		});
	// Long before any real "now", so the run reads as stalled.
	const deadRun = runningJob(new Date("2020-01-01T00:00:00.000Z"));

	beforeEach(() => {
		mockGather.mockReset();
		mockWarn.mockReset();
		mockPreference.mockResolvedValue(null);
	});

	it("is logged for investigation, with the project", async () => {
		mockGather.mockResolvedValue(
			evidenceWith({ context: { processing: deadRun } }),
		);

		const result = await run();

		const stalled = result.gates.find(
			(gate) => gate.reasonKey === "context.ingestion-stalled",
		);
		expect(stalled?.subjects).toEqual([]);
		expect(mockWarn).toHaveBeenCalledWith(
			expect.stringContaining("no identifiable source"),
			expect.objectContaining({
				projectId: "project_example",
				capabilityKey: "context.use-linked-source",
			}),
		);
	});

	it("is not logged when the stall names its source", async () => {
		mockGather.mockResolvedValue(
			evidenceWith({
				context: {
					processing: deadRun,
					stalledSources: [{ id: "context_a", label: "Example" }],
					stalledTotal: 1,
				},
			}),
		);

		await run();

		expect(mockWarn).not.toHaveBeenCalled();
	});
});
