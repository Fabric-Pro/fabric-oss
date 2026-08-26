/**
 * Project phase is settable after creation (Fizzy #2165 follow-up).
 *
 * This exists because the first cut shipped the phase on `create-project` only.
 * Nothing in the product sent it, and `update-project` did not accept it, so
 * every project stayed `UNJUDGED` and the readiness panel never rendered — a
 * feature that was live, migrated and completely unreachable. These assertions
 * pin the update path so that cannot recur silently.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateProject } = vi.hoisted(() => ({
	mockUpdateProject: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	updateProject: (...args: unknown[]) => mockUpdateProject(...args),
}));

import { updateProjectProcedure } from "../update-project";

/** The zod schema oRPC composed for this procedure. */
function inputSchema() {
	return (
		updateProjectProcedure as unknown as {
			"~orpc": { inputSchema: { parse: (v: unknown) => unknown } };
		}
	)["~orpc"].inputSchema;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("projects.update — project phase", () => {
	// These assert on the PARSED OUTPUT, never merely that parsing did not throw.
	// Zod strips unknown keys silently, so a `not.toThrow()` assertion passes
	// just as happily against a schema with no `projectPhase` at all — which is
	// precisely the bug being guarded against. Verified by removing the field
	// and watching these fail.
	it("carries both phases through to the parsed input", () => {
		for (const projectPhase of [
			"DISCOVERY_PLANNING",
			"DEVELOPMENT_EXECUTION",
		]) {
			const parsed = inputSchema().parse({ id: "p1", projectPhase }) as {
				projectPhase?: unknown;
			};
			expect(parsed.projectPhase).toBe(projectPhase);
		}
	});

	it("carries null through, which clears the phase back to unjudged", () => {
		// Distinct from omitting the field: null is a deliberate "no phase", and
		// it must survive parsing rather than being dropped.
		const parsed = inputSchema().parse({
			id: "p1",
			projectPhase: null,
		}) as {
			projectPhase?: unknown;
		};
		expect(parsed.projectPhase).toBeNull();
	});

	it("rejects a phase that is not one of the two", () => {
		expect(() =>
			inputSchema().parse({ id: "p1", projectPhase: "PLANNING" }),
		).toThrow();
	});

	it("accepts an expected development start date and coerces a date string", () => {
		const parsed = inputSchema().parse({
			id: "p1",
			projectPhase: "DISCOVERY_PLANNING",
			expectedDevelopmentStartDate: "2026-12-01",
		}) as { expectedDevelopmentStartDate?: Date };

		expect(parsed.expectedDevelopmentStartDate).toBeInstanceOf(Date);
		expect(parsed.expectedDevelopmentStartDate?.getUTCFullYear()).toBe(
			2026,
		);
	});

	it("still accepts an update that says nothing about the phase", () => {
		// Omitting the field must leave the stored phase alone — the settings form
		// is not the only caller of this procedure.
		const parsed = inputSchema().parse({ id: "p1", name: "Renamed" }) as {
			projectPhase?: unknown;
		};
		expect(parsed.projectPhase).toBeUndefined();
	});
});
