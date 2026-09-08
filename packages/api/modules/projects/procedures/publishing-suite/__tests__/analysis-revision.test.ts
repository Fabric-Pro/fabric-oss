import { beforeEach, describe, expect, it, vi } from "vitest";

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	saveAnalysisRevision: vi.fn(),
	listAnalysisRevisions: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	saveAnalysisRevision: dbMocks.saveAnalysisRevision,
	listAnalysisRevisions: dbMocks.listAnalysisRevisions,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));
// saveAnalysisRevisionProcedure's ratchet — mocked the same way the handler
// mocks above mock the DB layer, so this stays a pure handler-level test: the
// real ratchet (backed by `db.project`) is exercised against a real `db` mock
// in `packages/api/__tests__/publishing-suite-procedures.test.ts`, the same
// place `generatePlanningAnalysisProcedure`'s ratchet is covered.
const topicProjectMocks = vi.hoisted(() => ({
	requireEligibleProjectForTopic: vi.fn(),
}));
vi.mock("../../../lib/publishing-topic-project", () => ({
	requireEligibleProjectForTopic:
		topicProjectMocks.requireEligibleProjectForTopic,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
	// The input schema is captured, not discarded: the boundary bound on
	// `body` is enforced by Zod before the handler ever runs, so a
	// handler-level test cannot see it at all. Both the schema and the
	// permission are read off `chain` at `.handler()` time and frozen onto the
	// returned object — the chain itself is shared by the two procedures in
	// this module, so whichever declared its input last would otherwise be the
	// only one either could report.
	chain.input = (schema: unknown) => {
		chain.__input = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
		__input: chain.__input,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import {
	listAnalysisRevisionsProcedure,
	saveAnalysisRevisionProcedure,
} from "../analysis-revision";

type HandlerBearing = {
	handler: (args: {
		input: Record<string, unknown>;
		context: typeof ctx;
	}) => unknown;
	__permission: string;
	__input: { safeParse: (value: unknown) => { success: boolean } };
};

const saveHandler = (saveAnalysisRevisionProcedure as unknown as HandlerBearing)
	.handler;
const saveInput = (saveAnalysisRevisionProcedure as unknown as HandlerBearing)
	.__input;
const savePermission = (
	saveAnalysisRevisionProcedure as unknown as HandlerBearing
).__permission;
const listHandler = (
	listAnalysisRevisionsProcedure as unknown as HandlerBearing
).handler;
const listPermission = (
	listAnalysisRevisionsProcedure as unknown as HandlerBearing
).__permission;

const ctx = {
	user: { id: "user-session", name: "U", email: "u@example.com" },
	session: {},
};

// Every field a test asserts is FORWARDED carries a distinctive value here.
// `expectedVersion: null` and `organizationId: null` used to read as the
// obvious defaults, and each made its own assertion vacuous: a handler that
// hardcoded `null` instead of passing the input through would have satisfied
// both. Null is a real wire value for `expectedVersion` — the first revision
// sends it — so it gets its own case below rather than the shared fixture.
const SAVE_INPUT = {
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: "org-1",
	body: "Revised prose.",
	expectedVersion: 2,
	sourceAnalysisVersion: 3,
	changeSummary: "Tightened the second paragraph.",
};

async function callSave(input: Record<string, unknown>) {
	return saveHandler({ input, context: ctx });
}

async function callList(input: Record<string, unknown>) {
	return listHandler({ input, context: ctx });
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
	// A different id from the request's raw `projectId` on purpose: several
	// tests below assert the DB write is scoped to THIS (the loaded, ratchet-
	// resolved) id, not to whatever the client happened to send.
	topicProjectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "resolved-proj-1",
		organizationId: "org-1",
	});
	dbMocks.saveAnalysisRevision.mockResolvedValue({
		status: "saved",
		version: 4,
	});
	dbMocks.listAnalysisRevisions.mockResolvedValue([]);
});

describe("saveAnalysisRevision procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(savePermission).toBe("publishing-topic:update");
	});

	it("refuses a body past the length bound", () => {
		// The table is append-only and `listAnalysisRevisions` returns every
		// row's `@db.Text` body unpaginated, so an unbounded write is not one
		// oversized row — it is one oversized row in every later read of that
		// topic's history. Nothing upstream of Zod bounds it.
		expect(
			saveInput.safeParse({
				...SAVE_INPUT,
				body: "x".repeat(40000),
			}).success,
		).toBe(true);
		expect(
			saveInput.safeParse({
				...SAVE_INPUT,
				body: "x".repeat(40001),
			}).success,
		).toBe(false);
	});

	it("still accepts an emptied body — cleared is a decision, not a bad request", () => {
		// The bound deliberately carries no `.min(1)`, unlike the generated-
		// draft siblings. An author who removes every word has made a choice
		// the whole feature exists to tell apart from "never edited", and a
		// floor of one character would make it unsavable.
		expect(saveInput.safeParse({ ...SAVE_INPUT, body: "" }).success).toBe(
			true,
		);
	});

	it("applies the eligibility ratchet before saving", async () => {
		await callSave(SAVE_INPUT);

		expect(
			topicProjectMocks.requireEligibleProjectForTopic,
		).toHaveBeenCalledWith({
			projectId: "proj-1",
			clientOrganizationId: "org-1",
		});
	});

	it("writes under the RESOLVED project id, never the raw request field", async () => {
		// If the handler passed `input.projectId` straight through instead of
		// the ratchet's loaded `project.id`, this would see "proj-1" instead of
		// "resolved-proj-1" and fail.
		await callSave(SAVE_INPUT);

		expect(dbMocks.saveAnalysisRevision).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "resolved-proj-1" }),
		);
	});

	it("passes the caller as the author, never a client-supplied id", async () => {
		await callSave({ ...SAVE_INPUT, authorUserId: "someone-else" });

		expect(dbMocks.saveAnalysisRevision).toHaveBeenCalledWith(
			expect.objectContaining({ authorUserId: "user-session" }),
		);
	});

	it("forwards the body, version fields and change summary unchanged", async () => {
		await callSave(SAVE_INPUT);

		expect(dbMocks.saveAnalysisRevision).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "topic-1",
				body: "Revised prose.",
				expectedVersion: 2,
				sourceAnalysisVersion: 3,
				changeSummary: "Tightened the second paragraph.",
			}),
		);
	});

	it("forwards a null expectedVersion — the first revision's own token", async () => {
		// The compare-and-set token for a document nobody has edited yet. It
		// has to survive the handler as `null` and not become `undefined`,
		// which the query layer would read as "no expectation at all".
		await callSave({ ...SAVE_INPUT, expectedVersion: null });

		expect(dbMocks.saveAnalysisRevision).toHaveBeenCalledWith(
			expect.objectContaining({ expectedVersion: null }),
		);
	});

	it("defaults an omitted change summary to null, not undefined", async () => {
		const rest: Record<string, unknown> = { ...SAVE_INPUT };
		rest.changeSummary = undefined;
		await callSave(rest);

		expect(dbMocks.saveAnalysisRevision).toHaveBeenCalledWith(
			expect.objectContaining({ changeSummary: null }),
		);
	});

	it("returns the saved version on success", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({
			status: "saved",
			version: 7,
		});

		const result = await callSave(SAVE_INPUT);

		expect(result).toEqual({ saved: true, version: 7 });
	});

	it("maps a conflict from the query layer to CONFLICT, not 500", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({ status: "conflict" });

		await expect(callSave(SAVE_INPUT)).rejects.toMatchObject({
			code: "CONFLICT",
		});
	});

	it("maps an unknown source version to BAD_REQUEST", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({
			status: "unknown_source_version",
		});

		await expect(callSave(SAVE_INPUT)).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("maps a missing topic to NOT_FOUND, distinctly from an ineligible project", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({ status: "not_found" });

		await expect(callSave(SAVE_INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Topic not found",
		});
	});

	it("maps an ineligible project to NOT_FOUND, distinctly from a missing topic", async () => {
		dbMocks.saveAnalysisRevision.mockResolvedValue({
			status: "project_ineligible",
		});

		await expect(callSave(SAVE_INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	});

	it("NOT_FOUND when the ratchet itself refuses (archived, deleted or absent project)", async () => {
		topicProjectMocks.requireEligibleProjectForTopic.mockRejectedValue(
			Object.assign(new Error("Project not found"), {
				code: "NOT_FOUND",
			}),
		);

		await expect(callSave(SAVE_INPUT)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(dbMocks.saveAnalysisRevision).not.toHaveBeenCalled();
	});
});

describe("listAnalysisRevisions procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(listPermission).toBe("publishing-topic:read");
	});

	it("does not require project eligibility to READ the analysis history", async () => {
		// An archived project must still serve the read: the ratchet is never
		// even consulted.
		topicProjectMocks.requireEligibleProjectForTopic.mockRejectedValue(
			Object.assign(new Error("Project not found"), {
				code: "NOT_FOUND",
			}),
		);

		await expect(
			callList({ projectId: "proj-1", topicId: "topic-1" }),
		).resolves.toBeDefined();
		expect(
			topicProjectMocks.requireEligibleProjectForTopic,
		).not.toHaveBeenCalled();
	});

	it("re-scopes the read to the project, never the topic id alone", async () => {
		await callList({ projectId: "proj-1", topicId: "topic-1" });

		expect(dbMocks.listAnalysisRevisions).toHaveBeenCalledWith({
			projectId: "proj-1",
			topicId: "topic-1",
		});
	});

	it("answers a topic from another project exactly as a topic with no revisions", async () => {
		// DV16: existence must not leak through a difference in the answer.
		dbMocks.listAnalysisRevisions.mockResolvedValue([]);

		const result = await callList({
			projectId: "proj-1",
			topicId: "elsewhere",
		});

		expect(result).toEqual({ revisions: [] });
	});

	it("returns the revisions the DB helper produces, wrapped", async () => {
		const revision = {
			id: "rev-1",
			version: 2,
			body: "Revised prose.",
			sourceAnalysisVersion: 1,
			changeSummary: null,
			authorUserId: "user-session",
			createdAt: new Date("2026-09-01T00:00:00Z"),
			author: { id: "user-session", name: "Author Name" },
		};
		dbMocks.listAnalysisRevisions.mockResolvedValue([revision]);

		const result = await callList({
			projectId: "proj-1",
			topicId: "topic-1",
		});

		expect(result).toEqual({ revisions: [revision] });
	});
});
