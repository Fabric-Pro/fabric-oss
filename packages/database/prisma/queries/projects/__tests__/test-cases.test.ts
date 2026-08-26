/**
 * Unit tests for the Test Case query layer (`../test-cases`).
 *
 * Mocks the Prisma client (`../../../client`) — no real DB, mirroring the
 * `slack-huddle-notes.test.ts` / `pm-sync-resolve.test.ts` convention. Asserts
 * the pure decision logic these helpers own:
 *   - per-project identifier sequencing (`TC-NNN`) incl. the 999→1000 padding
 *     boundary, and the P2002 retry loop on the create race;
 *   - the bulk in-loop identifier counter (AI-draft path);
 *   - soft-delete returns `{ contextId }` (and no-ops on a missing/already-deleted row);
 *   - the `listTestCases` WHERE construction (filters + `deletedAt: null`);
 *   - `countTestCasesForStory` (the light coverage rollup);
 *   - link upsert defaults, sync-selector direction filters, and the PM-ref writer.
 *
 * XOR isolation across personal/org contexts, soft-delete exclusion from the
 * live list, and step replace/reorder against real rows live in
 * `test-cases.integration.test.ts` (self-skips when no DB is reachable).
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-cases.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock } = vi.hoisted(() => {
	const make = () => ({
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		findMany: vi.fn(),
		create: vi.fn(),
		createMany: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn(),
		count: vi.fn(),
		upsert: vi.fn(),
		groupBy: vi.fn(),
	});
	return {
		dbMock: {
			testCase: make(),
			testCaseStep: make(),
			testCaseWorkItemLink: make(),
			testPlanCase: make(),
			testCaseScriptRevision: make(),
			user: make(),
			// The create/update/clone/bulk paths write an activity event in the
			// same transaction; the tx client is this mock.
			testCaseActivity: make(),
			$transaction: vi.fn(),
		},
	};
});

vi.mock("../../../client", () => ({ db: dbMock }));

import { listTestCases } from "../test-case-list";
import { getTestCasesToSync, updateTestCasePmRefs } from "../test-case-pm-sync";
import { computePlanPassRates } from "../test-case-results";
import {
	bulkCreateTestCases,
	countTestCasesForStory,
	createTestCase,
	generateTestCaseIdentifier,
	linkTestCaseToWorkItem,
	reorderTestCases,
	setTestCaseContextId,
	softDeleteTestCase,
	unlinkTestCaseFromWorkItem,
	updateTestCase,
} from "../test-cases";

/**
 * The create/update/clone paths call `db.$transaction(cb)` (callback form) and
 * `reorderTestCases` calls `db.$transaction([...])` (array form). One default
 * impl serves both: a callback runs against the shared `dbMock` (so `tx` is the
 * same mocked client); an array resolves via `Promise.all`.
 */
function defaultTransaction() {
	dbMock.$transaction.mockImplementation(async (arg: unknown) =>
		typeof arg === "function"
			? (arg as (tx: unknown) => unknown)(dbMock)
			: Promise.all(arg as Promise<unknown>[]),
	);
}

/** Smart `testCase.findFirst`: identifier lookup vs order lookup by `orderBy`. */
function smartFindFirst(identifier: string | null, order: number | null) {
	dbMock.testCase.findFirst.mockImplementation(async (args: any) => {
		if (args?.orderBy?.createdAt) {
			return identifier ? { identifier } : null;
		}
		if (args?.orderBy?.order) {
			return order != null ? { order } : null;
		}
		return null;
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	defaultTransaction();
	dbMock.testCase.create.mockResolvedValue({ id: "tc1" });
	dbMock.testCase.update.mockResolvedValue({ id: "tc1" });
	dbMock.testCase.updateMany.mockResolvedValue({ count: 1 });
});

describe("generateTestCaseIdentifier", () => {
	it("starts at TC-001 for an empty project", async () => {
		dbMock.testCase.findFirst.mockResolvedValue(null);
		await expect(generateTestCaseIdentifier("p1")).resolves.toBe("TC-001");
	});

	it("increments the last identifier", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({ identifier: "TC-005" });
		await expect(generateTestCaseIdentifier("p1")).resolves.toBe("TC-006");
	});

	it("crosses the 999→1000 padding boundary without breaking", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({ identifier: "TC-999" });
		await expect(generateTestCaseIdentifier("p1")).resolves.toBe("TC-1000");
	});

	it("reads the most recent row by createdAt desc (monotonic with creation)", async () => {
		dbMock.testCase.findFirst.mockResolvedValue(null);
		await generateTestCaseIdentifier("p1");
		expect(dbMock.testCase.findFirst).toHaveBeenCalledWith({
			where: { projectId: "p1" },
			orderBy: { createdAt: "desc" },
			select: { identifier: true },
		});
	});
});

describe("createTestCase", () => {
	it("allocates TC-001 + order 1 and maps ordered steps for an empty project", async () => {
		smartFindFirst(null, null);
		dbMock.testCase.create.mockResolvedValue({
			id: "tc1",
			identifier: "TC-001",
		});

		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "Login",
			steps: [
				{ action: "open", expected: "form" },
				{ action: "submit", expected: "ok" },
			],
			userId: "u1",
			organizationId: null,
		});

		const arg = dbMock.testCase.create.mock.calls[0][0];
		expect(arg.data.identifier).toBe("TC-001");
		expect(arg.data.order).toBe(1);
		expect(arg.data.state).toBe("DRAFT");
		expect(arg.data.priority).toBe("MEDIUM");
		expect(arg.data.steps.create).toEqual([
			{
				order: 0,
				action: "open",
				expected: "form",
				data: undefined,
				sharedStepId: null,
			},
			{
				order: 1,
				action: "submit",
				expected: "ok",
				data: undefined,
				sharedStepId: null,
			},
		]);
	});

	it("continues the sequence (TC-006 / order 6) when prior cases exist", async () => {
		smartFindFirst("TC-005", 5);
		dbMock.testCase.create.mockResolvedValue({ id: "tc6" });

		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
		});

		const arg = dbMock.testCase.create.mock.calls[0][0];
		expect(arg.data.identifier).toBe("TC-006");
		expect(arg.data.order).toBe(6);
	});

	it("nests optional work-item links with the TESTS default", async () => {
		smartFindFirst(null, null);
		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
			workItemLinks: [{ userStoryId: "s1" }],
		});
		const arg = dbMock.testCase.create.mock.calls[0][0];
		expect(arg.data.workItemLinks.create).toEqual([
			{
				userStoryId: "s1",
				acceptanceCriterionRefs: [],
				linkType: "TESTS",
			},
		]);
	});

	it("retries the transaction once on a P2002 identifier race, then succeeds", async () => {
		smartFindFirst(null, null);
		dbMock.testCase.create.mockResolvedValue({
			id: "tc1",
			identifier: "TC-001",
		});
		dbMock.$transaction.mockRejectedValueOnce({ code: "P2002" });

		const result = await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
		});

		expect(result).toEqual({ id: "tc1", identifier: "TC-001" });
		expect(dbMock.$transaction).toHaveBeenCalledTimes(2);
	});

	it("propagates a non-P2002 error without retrying", async () => {
		dbMock.$transaction.mockReset();
		dbMock.$transaction.mockRejectedValue({ code: "P2003" });
		await expect(
			createTestCase({ projectId: "p1", createdById: "u1", title: "X" }),
		).rejects.toEqual({ code: "P2003" });
		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
	});

	it("a supplied automation ref implies AUTOMATED without the caller saying so", async () => {
		smartFindFirst(null, null);
		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
			automationRef: "login.spec.ts > signs in",
			automationFilePath: "apps/web/tests/e2e/login.spec.ts",
			automationExternalUrl: "https://ci.example.com/run/1",
		});
		const data = dbMock.testCase.create.mock.calls[0][0].data;
		expect(data.automationStatus).toBe("AUTOMATED");
		expect(data.automationRef).toBe("login.spec.ts > signs in");
		expect(data.automationFilePath).toBe(
			"apps/web/tests/e2e/login.spec.ts",
		);
		expect(data.automationExternalUrl).toBe("https://ci.example.com/run/1");
	});

	it("an explicit automationStatus wins over the ref (record a ref while still PLANNED)", async () => {
		smartFindFirst(null, null);
		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
			automationRef: "login.spec.ts > signs in",
			automationStatus: "PLANNED",
		});
		const data = dbMock.testCase.create.mock.calls[0][0].data;
		expect(data.automationStatus).toBe("PLANNED");
		expect(data.automationRef).toBe("login.spec.ts > signs in");
	});

	it("a blank ref is stored as null and does not imply AUTOMATED", async () => {
		smartFindFirst(null, null);
		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
			automationRef: "   ",
		});
		const data = dbMock.testCase.create.mock.calls[0][0].data;
		expect(data.automationRef).toBeNull();
		expect(data.automationStatus).toBe("NOT_AUTOMATED");
	});

	it("trims a ref so trailing whitespace can't create a distinct value", async () => {
		smartFindFirst(null, null);
		await createTestCase({
			projectId: "p1",
			createdById: "u1",
			title: "X",
			automationRef: "  spec.ts > t  ",
		});
		expect(dbMock.testCase.create.mock.calls[0][0].data.automationRef).toBe(
			"spec.ts > t",
		);
	});
});

describe("bulkCreateTestCases", () => {
	it("uses an in-loop counter so N cases get sequential identifiers in one transaction", async () => {
		smartFindFirst("TC-005", 5);
		dbMock.testCase.create
			.mockResolvedValueOnce({ id: "a" })
			.mockResolvedValueOnce({ id: "b" });

		const created = await bulkCreateTestCases({
			projectId: "p1",
			createdById: "u1",
			cases: [{ title: "A" }, { title: "B" }],
		});

		expect(created).toHaveLength(2);
		expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
		expect(dbMock.testCase.create.mock.calls[0][0].data.identifier).toBe(
			"TC-006",
		);
		expect(dbMock.testCase.create.mock.calls[0][0].data.order).toBe(6);
		expect(dbMock.testCase.create.mock.calls[1][0].data.identifier).toBe(
			"TC-007",
		);
		expect(dbMock.testCase.create.mock.calls[1][0].data.order).toBe(7);
	});

	it("short-circuits to [] with no transaction when given no cases", async () => {
		const created = await bulkCreateTestCases({
			projectId: "p1",
			createdById: "u1",
			cases: [],
		});
		expect(created).toEqual([]);
		expect(dbMock.$transaction).not.toHaveBeenCalled();
	});

	it("forces DRAFT state on every bulk-created case (AI-draft invariant)", async () => {
		smartFindFirst(null, null);
		dbMock.testCase.create.mockResolvedValue({ id: "a" });
		await bulkCreateTestCases({
			projectId: "p1",
			createdById: "u1",
			cases: [{ title: "A", steps: [{ action: "a", expected: "e" }] }],
		});
		expect(dbMock.testCase.create.mock.calls[0][0].data.state).toBe(
			"DRAFT",
		);
	});
});

describe("updateTestCase", () => {
	// The pre-update snapshot the diff reads (state/priority/title/automation +
	// step count). Every test that reaches the update returns this as the FIRST
	// findFirst; the second findFirst (the detail re-read) can stay minimal.
	const existingRow = {
		id: "tc1",
		state: "DRAFT",
		priority: "MEDIUM",
		title: "T",
		automationStatus: "NOT_AUTOMATED",
		playwrightScript: null,
		_count: { steps: 0 },
	};

	it("returns null (and never writes) when the case is missing/soft-deleted", async () => {
		dbMock.testCase.findFirst.mockResolvedValueOnce(null);
		const result = await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: { title: "X" },
		});
		expect(result).toBeNull();
		expect(dbMock.testCase.update).not.toHaveBeenCalled();
	});

	it("re-guards deletedAt:null on the existence check", async () => {
		dbMock.testCase.findFirst.mockResolvedValueOnce(null);
		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: { title: "X" },
		});
		expect(dbMock.testCase.findFirst.mock.calls[0][0].where).toEqual({
			id: "tc1",
			projectId: "p1",
			deletedAt: null,
		});
	});

	it("only writes the provided scalar fields", async () => {
		dbMock.testCase.findFirst
			.mockResolvedValueOnce(existingRow)
			.mockResolvedValueOnce({ id: "tc1" });
		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: { state: "READY", pmAutoSyncEnabled: true },
		});
		expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
			state: "READY",
			pmAutoSyncEnabled: true,
		});
	});

	it("stores an authored revision when a scripted test changes", async () => {
		dbMock.testCase.findFirst
			.mockResolvedValueOnce(existingRow)
			.mockResolvedValueOnce({ id: "tc1" });
		dbMock.user.findUnique.mockResolvedValue({
			name: "Ada",
			email: "ada@example.com",
		});

		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			actorUserId: "u1",
			data: {
				playwrightScript:
					"module.exports = async ({ page }) => page.title();",
			},
			scriptRevision: {
				origin: "AGENT_RUN_AND_REPO",
				sourceResultEventId: "event-1",
			},
		});

		expect(dbMock.testCaseScriptRevision.create).toHaveBeenCalledWith({
			data: {
				projectId: "p1",
				testCaseId: "tc1",
				script: "module.exports = async ({ page }) => page.title();",
				origin: "AGENT_RUN_AND_REPO",
				authoredByUserId: "u1",
				authorNameSnapshot: "Ada",
				authorEmailSnapshot: "ada@example.com",
				sourceResultEventId: "event-1",
				restoredFromRevisionId: null,
			},
		});
	});

	it("does not add history for a no-op script save", async () => {
		const script = "module.exports = async ({ page }) => page.title();";
		dbMock.testCase.findFirst
			.mockResolvedValueOnce({
				...existingRow,
				playwrightScript: script,
			})
			.mockResolvedValueOnce({ id: "tc1" });

		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			actorUserId: "u1",
			data: { playwrightScript: script },
		});

		expect(dbMock.testCaseScriptRevision.create).not.toHaveBeenCalled();
		expect(dbMock.user.findUnique).not.toHaveBeenCalled();
	});

	it("replaces steps: deletes omitted ids, updates kept ids, creates new, renumbers order", async () => {
		dbMock.testCase.findFirst
			.mockResolvedValueOnce(existingRow)
			.mockResolvedValueOnce({ id: "tc1" });
		// Existing steps s1 + s2; incoming keeps s2, drops s1, adds a new step.
		dbMock.testCaseStep.findMany.mockResolvedValue([
			{ id: "s1" },
			{ id: "s2" },
		]);

		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: {
				steps: [
					{ id: "s2", action: "keep", expected: "k" },
					{ action: "new", expected: "n" },
				],
			},
		});

		// s1 (not kept) deleted via notIn the kept set.
		expect(dbMock.testCaseStep.deleteMany).toHaveBeenCalledWith({
			where: { testCaseId: "tc1", id: { notIn: ["s2"] } },
		});
		// kept s2 updated to order 0.
		expect(dbMock.testCaseStep.update).toHaveBeenCalledWith({
			where: { id: "s2" },
			data: {
				order: 0,
				action: "keep",
				expected: "k",
				data: undefined,
				sharedStepId: null,
			},
		});
		// new step created at order 1.
		expect(dbMock.testCaseStep.create).toHaveBeenCalledWith({
			data: {
				testCaseId: "tc1",
				order: 1,
				action: "new",
				expected: "n",
				data: undefined,
				sharedStepId: null,
			},
		});
	});

	it("deletes ALL steps when an empty step list is supplied (full replace)", async () => {
		dbMock.testCase.findFirst
			.mockResolvedValueOnce(existingRow)
			.mockResolvedValueOnce({ id: "tc1" });
		dbMock.testCaseStep.findMany.mockResolvedValue([{ id: "s1" }]);

		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: { steps: [] },
		});

		expect(dbMock.testCaseStep.deleteMany).toHaveBeenCalledWith({
			where: { testCaseId: "tc1" },
		});
		expect(dbMock.testCaseStep.create).not.toHaveBeenCalled();
	});

	it("leaves steps untouched when `steps` is omitted", async () => {
		dbMock.testCase.findFirst
			.mockResolvedValueOnce(existingRow)
			.mockResolvedValueOnce({ id: "tc1" });
		await updateTestCase({
			id: "tc1",
			projectId: "p1",
			data: { title: "X" },
		});
		expect(dbMock.testCaseStep.findMany).not.toHaveBeenCalled();
		expect(dbMock.testCaseStep.deleteMany).not.toHaveBeenCalled();
	});

	/** The automation-link write rules — see `resolveAutomationStatus`. */
	describe("automation link", () => {
		beforeEach(() => {
			dbMock.testCase.findFirst
				.mockResolvedValueOnce(existingRow)
				.mockResolvedValueOnce({ id: "tc1" });
		});

		it("setting a ref flips the case to AUTOMATED", async () => {
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: { automationRef: "login.spec.ts > signs in" },
			});
			expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
				automationRef: "login.spec.ts > signs in",
				automationStatus: "AUTOMATED",
			});
		});

		it("an automationStatus in the SAME request wins over the ref", async () => {
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: {
					automationRef: "login.spec.ts > signs in",
					automationStatus: "PLANNED",
				},
			});
			expect(
				dbMock.testCase.update.mock.calls[0][0].data.automationStatus,
			).toBe("PLANNED");
		});

		it("clearing the ref nulls it WITHOUT downgrading the status", async () => {
			// The status is intent a user may have set deliberately; silently
			// downgrading it would be a surprising side effect of clearing a text
			// field. The stat stays honest regardless, because it counts refs.
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: { automationRef: "" },
			});
			expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
				automationRef: null,
			});
		});

		it("clearing via explicit null also leaves the status alone", async () => {
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: { automationRef: null },
			});
			expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
				automationRef: null,
			});
		});

		it("omitted automation fields are not written (partial update never wipes them)", async () => {
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: { title: "X" },
			});
			expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
				title: "X",
			});
		});

		it("writes the file path and CI link, collapsing blanks to null", async () => {
			await updateTestCase({
				id: "tc1",
				projectId: "p1",
				data: {
					automationFilePath: "apps/web/tests/e2e/login.spec.ts",
					automationExternalUrl: "",
				},
			});
			expect(dbMock.testCase.update.mock.calls[0][0].data).toEqual({
				automationFilePath: "apps/web/tests/e2e/login.spec.ts",
				automationExternalUrl: null,
			});
		});
	});
});

describe("reorderTestCases", () => {
	it("writes each order scoped to the project + live rows (tenant + soft-delete guard)", async () => {
		await reorderTestCases("p1", [
			{ id: "a", order: 2 },
			{ id: "b", order: 1 },
		]);
		expect(dbMock.testCase.updateMany).toHaveBeenCalledWith({
			where: { id: "a", projectId: "p1", deletedAt: null },
			data: { order: 2 },
		});
		expect(dbMock.testCase.updateMany).toHaveBeenCalledWith({
			where: { id: "b", projectId: "p1", deletedAt: null },
			data: { order: 1 },
		});
	});
});

describe("softDeleteTestCase", () => {
	it("returns { id, contextId } and stamps deletedAt", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({
			id: "tc1",
			contextId: "ctx1",
		});

		const result = await softDeleteTestCase({ id: "tc1", projectId: "p1" });

		expect(result).toEqual({ id: "tc1", contextId: "ctx1" });
		const updateArg = dbMock.testCase.update.mock.calls[0][0];
		expect(updateArg.where).toEqual({ id: "tc1" });
		expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
	});

	it("returns null and never writes when the case is absent/already deleted", async () => {
		dbMock.testCase.findFirst.mockResolvedValue(null);
		const result = await softDeleteTestCase({ id: "tc1", projectId: "p1" });
		expect(result).toBeNull();
		expect(dbMock.testCase.update).not.toHaveBeenCalled();
	});

	it("guards the lookup by projectId + deletedAt:null", async () => {
		dbMock.testCase.findFirst.mockResolvedValue({
			id: "tc1",
			contextId: null,
		});
		await softDeleteTestCase({ id: "tc1", projectId: "p1" });
		expect(dbMock.testCase.findFirst).toHaveBeenCalledWith({
			where: { id: "tc1", projectId: "p1", deletedAt: null },
			select: { id: true, contextId: true },
		});
	});
});

describe("listTestCases", () => {
	beforeEach(() => {
		dbMock.testCase.findMany.mockResolvedValue([{ id: "tc1" }]);
		// Distinct values per predicate so the summary's two coverage numerators
		// can't silently swap: a blanket `1` would let either count stand in for
		// the other and the assertion would still pass.
		dbMock.testCase.count.mockImplementation(async (args: any) =>
			args?.where?.lastRunSource === "PIPELINE" ? 4 : 1,
		);
	});

	it("always scopes to projectId + deletedAt:null and returns { items, total }", async () => {
		const result = await listTestCases({ projectId: "p1" });
		expect(result).toEqual({ items: [{ id: "tc1" }], total: 1 });
		expect(dbMock.testCase.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
		});
	});

	it("composes state / priority / tag / linkedStory / externalLinked / search filters", async () => {
		await listTestCases({
			projectId: "p1",
			state: "READY",
			priority: "HIGH",
			tag: "smoke",
			linkedStoryId: "s1",
			externalLinked: true,
			search: "login",
		});
		const where = dbMock.testCase.findMany.mock.calls[0][0].where;
		expect(where.state).toBe("READY");
		expect(where.priority).toBe("HIGH");
		expect(where.tags).toEqual({ has: "smoke" });
		expect(where.workItemLinks).toEqual({ some: { userStoryId: "s1" } });
		expect(where.externalId).toEqual({ not: null });
		expect(where.OR).toEqual([
			{ title: { contains: "login", mode: "insensitive" } },
			{ identifier: { contains: "login", mode: "insensitive" } },
			{ description: { contains: "login", mode: "insensitive" } },
		]);
	});

	it("externalLinked:false filters to unlinked cases (externalId null)", async () => {
		await listTestCases({ projectId: "p1", externalLinked: false });
		expect(
			dbMock.testCase.findMany.mock.calls[0][0].where.externalId,
		).toBeNull();
	});

	it("orders by `order` asc, tie-broken by identifier, and paginates via take/skip", async () => {
		await listTestCases({ projectId: "p1", limit: 25, offset: 50 });
		const arg = dbMock.testCase.findMany.mock.calls[0][0];
		// The identifier tiebreak makes the ordering TOTAL — without it, rows
		// sharing a sort key have no defined order and a paging reader could see
		// one twice (or miss one) as `offset` advances.
		expect(arg.orderBy).toEqual([{ order: "asc" }, { identifier: "asc" }]);
		expect(arg.take).toBe(25);
		expect(arg.skip).toBe(50);
	});

	it("does not run the summary aggregates unless includeSummary is set", async () => {
		const result = await listTestCases({ projectId: "p1", state: "READY" });
		expect(dbMock.testCase.groupBy).not.toHaveBeenCalled();
		expect(result).toEqual({ items: [{ id: "tc1" }], total: 1 });
	});

	it("includeSummary returns zero-filled, state-INDEPENDENT tallies (correct across pagination)", async () => {
		dbMock.testCase.groupBy.mockImplementation(async (args: any) => {
			switch (args.by[0]) {
				case "state":
					return [
						{ state: "READY", _count: { _all: 3 } },
						{ state: "DRAFT", _count: { _all: 2 } },
					];
				case "automationStatus":
					return [
						{ automationStatus: "AUTOMATED", _count: { _all: 1 } },
					];
				case "currentResult":
					return [
						{ currentResult: "PASSED", _count: { _all: 2 } },
						{ currentResult: "FAILED", _count: { _all: 1 } },
					];
				default:
					return [];
			}
		});

		const result = await listTestCases({
			projectId: "p1",
			state: "READY",
			includeSummary: true,
		});

		// Every bucket is zero-filled (groupBy omits empty groups); total = sum of
		// the state tally.
		expect(result.summary).toEqual({
			total: 5,
			// PROPOSED is zero-filled like every other empty bucket, so the
			// toolbar renders a "0" rather than omitting the filter entirely.
			stateCounts: { PROPOSED: 0, READY: 3, DRAFT: 2, CLOSED: 0 },
			automationCounts: { NOT_AUTOMATED: 0, PLANNED: 0, AUTOMATED: 1 },
			automatedWithRefCount: 1,
			pipelineCoveredCount: 4,
			// Zero-filled means EVERY TestResult key is present, including ones no
			// case currently holds — that is what makes the tally safe to index
			// without guarding. SKIPPED joined the enum with result normalisation.
			resultCounts: {
				NOT_RUN: 0,
				PASSED: 2,
				FAILED: 1,
				BLOCKED: 0,
				SKIPPED: 0,
			},
		});
		// The two coverage numerators must come from DIFFERENT predicates:
		// "marked automated with a ref" vs "a pipeline actually produced the
		// latest result". A single count reused for both would make automation
		// intent read as real execution.
		const countWheres = dbMock.testCase.count.mock.calls.map(
			(c: any) => c[0].where,
		);
		expect(countWheres).toContainEqual(
			expect.objectContaining({
				automationStatus: "AUTOMATED",
				automationRef: { not: null },
			}),
		);
		expect(countWheres).toContainEqual(
			expect.objectContaining({ lastRunSource: "PIPELINE" }),
		);
		// The items query IS state-filtered; the summary groupBys are NOT — so the
		// segmented counts stay stable no matter which state tab is active.
		expect(dbMock.testCase.findMany.mock.calls[0][0].where.state).toBe(
			"READY",
		);
		for (const call of dbMock.testCase.groupBy.mock.calls) {
			expect(call[0].where.state).toBeUndefined();
			expect(call[0].where).toMatchObject({
				projectId: "p1",
				deletedAt: null,
			});
		}
	});

	it("counts a case as automated only when it is AUTOMATED *and* ref-backed", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([]);
		await listTestCases({ projectId: "p1", includeSummary: true });

		// The automation-% numerator is its own DB count, not a slice of the
		// automationStatus tally: a case marked AUTOMATED with no ref must not
		// inflate the stat, and that conjunction can't come from the groupBy.
		const where = findRefCountWhere();
		expect(where).toMatchObject({
			projectId: "p1",
			deletedAt: null,
			automationStatus: "AUTOMATED",
			automationRef: { not: null },
		});
		// It stays state-independent, like the other summary aggregates.
		expect(where.state).toBeUndefined();
	});

	it("keeps the ref-backed count under the other active filters", async () => {
		dbMock.testCase.groupBy.mockResolvedValue([]);
		await listTestCases({
			projectId: "p1",
			priority: "HIGH",
			includeSummary: true,
		});
		expect(findRefCountWhere().priority).toBe("HIGH");
	});
});

/**
 * The `where` of the ref-backed automation count — the only `testCase.count`
 * call that constrains `automationRef` (the other is the plain list total).
 * Throws rather than returning undefined so a caller can assert on it directly.
 */
function findRefCountWhere(): Record<string, any> {
	const call = dbMock.testCase.count.mock.calls.find(
		(c: any) => c[0]?.where?.automationRef !== undefined,
	);
	if (!call) {
		throw new Error("no ref-backed automation count query was issued");
	}
	return call[0].where;
}

describe("computePlanPassRates", () => {
	it("returns an empty map (and runs no query) for no plan ids", async () => {
		const res = await computePlanPassRates([]);
		expect(res.size).toBe(0);
		expect(dbMock.testPlanCase.findMany).not.toHaveBeenCalled();
	});

	it("batches ONE query and rolls up per plan, zero-filling plans with no cases", async () => {
		dbMock.testPlanCase.findMany.mockResolvedValue([
			{ planId: "p-a", testCase: { currentResult: "PASSED" } },
			{ planId: "p-a", testCase: { currentResult: "PASSED" } },
			{ planId: "p-a", testCase: { currentResult: "FAILED" } },
			{ planId: "p-a", testCase: { currentResult: "NOT_RUN" } },
			{ planId: "p-b", testCase: { currentResult: "BLOCKED" } },
		]);

		const res = await computePlanPassRates(["p-a", "p-b", "p-c"]);

		// ONE query (not N+1), scoped to the live member cases of these plans.
		expect(dbMock.testPlanCase.findMany).toHaveBeenCalledTimes(1);
		expect(dbMock.testPlanCase.findMany.mock.calls[0][0].where).toEqual({
			planId: { in: ["p-a", "p-b", "p-c"] },
			testCase: { deletedAt: null },
		});

		// p-a: 2 passed / 3 executed (passed+failed+blocked); 1 not-run excluded.
		expect(res.get("p-a")).toMatchObject({
			total: 4,
			passed: 2,
			failed: 1,
			blocked: 0,
			notRun: 1,
			executed: 3,
			passRate: 2 / 3,
		});
		// p-b: 1 blocked, 0 passed → 0% over 1 executed.
		expect(res.get("p-b")).toMatchObject({
			total: 1,
			blocked: 1,
			executed: 1,
			passRate: 0,
		});
		// p-c: requested but has no cases → all-zero rollup PRESENT (not missing).
		expect(res.get("p-c")).toMatchObject({
			total: 0,
			executed: 0,
			passRate: 0,
		});
	});
});

describe("countTestCasesForStory", () => {
	it("counts live cases linked to the story (the coverage rollup)", async () => {
		dbMock.testCase.count.mockResolvedValue(3);
		const n = await countTestCasesForStory({
			storyId: "s1",
			projectId: "p1",
		});
		expect(n).toBe(3);
		expect(dbMock.testCase.count).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				deletedAt: null,
				// PROPOSED cases are excluded: nobody has accepted them, so they
				// must not raise a coverage number. CLOSED is deliberately still
				// counted — excluding it would drop the figure for every existing
				// project, which is a separate product decision.
				state: { notIn: ["PROPOSED"] },
				workItemLinks: { some: { userStoryId: "s1" } },
			},
		});
	});
});

describe("linkTestCaseToWorkItem", () => {
	it("upserts on the (testCaseId,userStoryId) unique key with the TESTS default", async () => {
		dbMock.testCaseWorkItemLink.upsert.mockResolvedValue({ id: "l1" });
		await linkTestCaseToWorkItem({
			testCaseId: "tc1",
			userStoryId: "s1",
			acceptanceCriterionRefs: ["AC 2"],
		});
		expect(dbMock.testCaseWorkItemLink.upsert).toHaveBeenCalledWith({
			where: {
				testCaseId_userStoryId: {
					testCaseId: "tc1",
					userStoryId: "s1",
				},
			},
			create: {
				testCaseId: "tc1",
				userStoryId: "s1",
				acceptanceCriterionRefs: ["AC 2"],
				linkType: "TESTS",
			},
			update: { acceptanceCriterionRefs: ["AC 2"] },
		});
	});
});

describe("unlinkTestCaseFromWorkItem", () => {
	it("deletes the link idempotently and reports the rows removed", async () => {
		dbMock.testCaseWorkItemLink.deleteMany.mockResolvedValue({ count: 1 });
		const res = await unlinkTestCaseFromWorkItem({
			testCaseId: "tc1",
			userStoryId: "s1",
		});
		expect(res).toEqual({ removed: 1 });
		expect(dbMock.testCaseWorkItemLink.deleteMany).toHaveBeenCalledWith({
			where: { testCaseId: "tc1", userStoryId: "s1" },
		});
	});
});

describe("getTestCasesToSync", () => {
	beforeEach(() => {
		dbMock.testCase.findMany.mockResolvedValue([]);
	});

	it("push + unsyncedOnly → only unsynced cases (externalId null)", async () => {
		await getTestCasesToSync({ projectId: "p1", unsyncedOnly: true });
		expect(dbMock.testCase.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
			externalId: null,
		});
	});

	it("pull → only already-pushed cases (externalId not null)", async () => {
		await getTestCasesToSync({ projectId: "p1", direction: "pull" });
		expect(dbMock.testCase.findMany.mock.calls[0][0].where).toEqual({
			projectId: "p1",
			deletedAt: null,
			externalId: { not: null },
		});
	});

	it("narrows to explicit testCaseIds when provided", async () => {
		await getTestCasesToSync({ projectId: "p1", testCaseIds: ["a", "b"] });
		expect(dbMock.testCase.findMany.mock.calls[0][0].where.id).toEqual({
			in: ["a", "b"],
		});
	});
});

describe("updateTestCasePmRefs", () => {
	it("writes external refs scoped to id+projectId and stamps lastSyncedAt", async () => {
		await updateTestCasePmRefs({
			id: "tc1",
			projectId: "p1",
			externalId: "ADO-42",
			externalUrl: "https://dev.azure.com/x/42",
			externalMcpServerId: "mcp1",
			lastSyncedPmHash: "h1",
		});
		const arg = dbMock.testCase.updateMany.mock.calls[0][0];
		expect(arg.where).toEqual({ id: "tc1", projectId: "p1" });
		expect(arg.data.externalId).toBe("ADO-42");
		expect(arg.data.externalUrl).toBe("https://dev.azure.com/x/42");
		expect(arg.data.externalMcpServerId).toBe("mcp1");
		expect(arg.data.lastSyncedPmHash).toBe("h1");
		expect(arg.data.lastSyncedAt).toBeInstanceOf(Date);
	});
});

describe("setTestCaseContextId", () => {
	it("persists the ProjectContext pointer back onto the case", async () => {
		dbMock.testCase.update.mockResolvedValue({
			id: "tc1",
			contextId: "ctx1",
		});
		await setTestCaseContextId({ id: "tc1", contextId: "ctx1" });
		expect(dbMock.testCase.update).toHaveBeenCalledWith({
			where: { id: "tc1" },
			data: { contextId: "ctx1" },
			select: { id: true, contextId: true },
		});
	});
});
