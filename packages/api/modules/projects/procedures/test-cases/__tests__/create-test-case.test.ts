import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	// The procedure validates state against this shared constant; a mock that
	// omits it fails at import, not at assertion.
	TEST_CASE_STATES: ["PROPOSED", "DRAFT", "READY", "CLOSED"],
	db: { userStory: { findMany: vi.fn() } },
	createTestCase: vi.fn(),
}));
vi.mock("../../../lib/test-case-context", () => ({
	syncTestCaseContext: vi.fn(),
	buildTestCaseContextContent: vi.fn(() => "context-body"),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? undefined,
		Permissions: {
			TEST_CASE_CREATE: "test-case:create",
		},
	};
});

import { createTestCase, db } from "@repo/database";
import { syncTestCaseContext } from "../../../lib/test-case-context";
import { createTestCaseProcedure } from "../create-test-case";

const handler = (createTestCaseProcedure as unknown as { handler: Function })
	.handler;
const ctx = {
	user: { id: "u1", name: "U", email: "u@example.com" },
	session: {},
};

function fakeDetail(overrides: Record<string, unknown> = {}) {
	return {
		id: "tc1",
		projectId: "p1",
		identifier: "TC-001",
		title: "Login works",
		description: null,
		state: "DRAFT",
		priority: "MEDIUM",
		ownerId: null,
		tags: [],
		automationStatus: "NOT_AUTOMATED",
		order: 1,
		createdById: "u1",
		externalId: null,
		contextId: null,
		userId: "u1",
		organizationId: null,
		steps: [],
		workItemLinks: [],
		planLinks: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(createTestCase).mockResolvedValue(fakeDetail() as never);
});

describe("createTestCaseProcedure", () => {
	it("is gated on TEST_CASE_CREATE", () => {
		expect(
			(createTestCaseProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:create");
	});

	it("creates the case and mirrors it into the RAG context (syncTestCaseContext)", async () => {
		const res = await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				title: "Login works",
			},
			context: ctx,
		});

		expect(createTestCase).toHaveBeenCalledTimes(1);
		expect(syncTestCaseContext).toHaveBeenCalledTimes(1);
		expect(syncTestCaseContext).toHaveBeenCalledWith(
			expect.objectContaining({ testCaseId: "tc1", projectId: "p1" }),
		);
		expect(res).toEqual({ testCase: fakeDetail() });
	});

	it("forwards the automation link to the query layer, which owns the AUTOMATED rule", async () => {
		await handler({
			input: {
				projectId: "p1",
				organizationId: null,
				title: "Login works",
				automationRef: "login.spec.ts > signs in",
				automationFilePath: "apps/web/tests/e2e/login.spec.ts",
				automationExternalUrl: "https://ci.example.com/run/1",
			},
			context: ctx,
		});

		expect(createTestCase).toHaveBeenCalledWith(
			expect.objectContaining({
				automationRef: "login.spec.ts > signs in",
				automationFilePath: "apps/web/tests/e2e/login.spec.ts",
				automationExternalUrl: "https://ci.example.com/run/1",
			}),
		);
	});

	it("rejects creation that links a work item from another project (NOT_FOUND)", async () => {
		// Only one of the two requested stories resolves in-project → the whole
		// create is refused rather than silently linking a foreign work item.
		vi.mocked(db.userStory.findMany).mockResolvedValue([
			{ id: "s1" },
		] as never);

		await expect(
			handler({
				input: {
					projectId: "p1",
					organizationId: null,
					title: "Login works",
					workItemLinks: [
						{ userStoryId: "s1" },
						{ userStoryId: "s-foreign" },
					],
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(createTestCase).not.toHaveBeenCalled();
		expect(syncTestCaseContext).not.toHaveBeenCalled();
	});
});
