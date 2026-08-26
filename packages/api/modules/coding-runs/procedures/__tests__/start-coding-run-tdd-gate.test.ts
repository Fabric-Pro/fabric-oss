/**
 * The test-first gate on starting an implementation session.
 *
 * A project that works test-first should not have Fabric write code for a
 * feature that has nothing to test against. This is the only place Fabric can
 * hold that line, because it is the only implementation Fabric starts —
 * somebody working in their own editor passes no gate at all, which is why the
 * feature's QA tab carries a visible warning as well.
 *
 * The two mistakes this could easily make, and does not:
 *
 *  - requiring a case to PASS. Nothing can pass before the code exists, so that
 *    would leave a test-first project unable to start any work at all;
 *  - firing on projects that never asked for it. The setting is off by default
 *    and the gate is silent without it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	userStory: { findFirst: vi.fn() },
	codingRun: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("@repo/database", () => ({ db: dbMock }));
vi.mock("@repo/logs", () => ({ logWorkflowEvent: vi.fn() }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("@repo/utils", () => ({
	READ_ONLY_MODE_ERROR_CODE: "READ_ONLY_MODE",
	READ_ONLY_MODE_MESSAGE: "read only",
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (m: unknown) => m,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
		Permissions: { AGENT_EXECUTE: "agent:execute" },
	};
});

import { startCodingRunProcedure } from "../start-coding-run";

// biome-ignore lint/complexity/noBannedTypes: matches the sibling procedure tests.
const handler = (startCodingRunProcedure as { handler: Function }).handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = { projectId: "p1", storyId: "s1" };

/** A feature whose project is NOT test-first and which has no cases. */
function story(overrides: Record<string, unknown> = {}) {
	return {
		id: "s1",
		title: "Checkout",
		tasks: [],
		project: {
			name: "Demo",
			organizationId: "org1",
			repositoryUrl: "https://github.com/example-org/example-repo",
			repositoryOwner: "example-org",
			repositoryName: "example-repo",
			defaultBranch: "main",
			readOnlyMode: false,
			applyTddApproach: false,
		},
		testCaseLinks: [],
		...overrides,
	};
}

function tddStory(links: { id: string }[]) {
	const s = story();
	return {
		...s,
		project: { ...s.project, applyTddApproach: true },
		testCaseLinks: links,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.codingRun.findFirst.mockResolvedValue(null);
});

describe("start-coding-run — test-first gate", () => {
	it("refuses when the project is test-first and the feature has no cases", async () => {
		dbMock.userStory.findFirst.mockResolvedValue(tddStory([]));

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			data: { errorCode: "TDD_REQUIRES_TEST_CASES" },
		});
	});

	it("names both ways out, so the refusal is actionable", async () => {
		// Write a case, or turn the setting off. A refusal that only says "no"
		// sends somebody to read the source to find out what it wants.
		dbMock.userStory.findFirst.mockResolvedValue(tddStory([]));

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/test cases yet.*(by hand|AI).*Apply TDD approach/is,
		);
	});

	it("refuses BEFORE creating a run row", async () => {
		// The whole point is that no implementation starts. A gate that fires
		// after the row exists leaves a phantom run behind.
		dbMock.userStory.findFirst.mockResolvedValue(tddStory([]));

		await expect(handler({ input, context: ctx })).rejects.toThrow();
		expect(dbMock.codingRun.create).not.toHaveBeenCalled();
	});

	it("allows the run once the feature has a case", async () => {
		dbMock.userStory.findFirst.mockResolvedValue(tddStory([{ id: "l1" }]));

		// Past the gate. It fails later for want of a Temporal client, which is
		// what proves the gate is no longer what stops it.
		await expect(
			handler({ input, context: ctx }),
		).rejects.not.toMatchObject({
			data: { errorCode: "TDD_REQUIRES_TEST_CASES" },
		});
	});

	it("is silent for a project that never turned test-first on", async () => {
		// Default projects — the majority — must not notice this exists.
		dbMock.userStory.findFirst.mockResolvedValue(story());

		await expect(
			handler({ input, context: ctx }),
		).rejects.not.toMatchObject({
			data: { errorCode: "TDD_REQUIRES_TEST_CASES" },
		});
	});

	it("asks the database for live cases only", async () => {
		// A link outlives the case it points at, so a soft-deleted case must not
		// count as coverage — otherwise deleting the last case silently reopens
		// the gate it was holding shut.
		dbMock.userStory.findFirst.mockResolvedValue(tddStory([{ id: "l1" }]));

		await handler({ input, context: ctx }).catch(() => undefined);

		const include = dbMock.userStory.findFirst.mock.calls[0][0].include;
		expect(include.testCaseLinks.where).toEqual({
			testCase: { deletedAt: null },
		});
	});

	it("still refuses a read-only project first", async () => {
		// Read-only is the broader refusal and must not be masked by this one.
		const s = tddStory([]);
		dbMock.userStory.findFirst.mockResolvedValue({
			...s,
			project: { ...s.project, readOnlyMode: true },
		});

		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			data: { errorCode: "READ_ONLY_MODE" },
		});
	});
});
