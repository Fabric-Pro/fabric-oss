import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	// The procedure validates state against this shared constant; a mock that
	// omits it fails at import, not at assertion.
	TEST_CASE_STATES: ["PROPOSED", "DRAFT", "READY", "CLOSED"],
	updateTestCase: vi.fn(),
}));
vi.mock("../../../lib/test-case-context", () => ({
	syncTestCaseContext: vi.fn(),
	buildTestCaseContextContent: vi.fn(() => "context-body"),
}));
vi.mock("../../../lib/enqueue-test-case-auto-sync", () => ({
	enqueueTestCaseAutoSync: vi.fn(),
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
			TEST_CASE_UPDATE: "test-case:update",
		},
	};
});

import { updateTestCase } from "@repo/database";
import { updateTestCaseProcedure } from "../update-test-case";

const handler = (updateTestCaseProcedure as unknown as { handler: Function })
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
		state: "DRAFT",
		automationStatus: "NOT_AUTOMATED",
		automationRef: null,
		automationFilePath: null,
		automationExternalUrl: null,
		externalId: null,
		pmAutoSyncEnabled: false,
		steps: [],
		workItemLinks: [],
		planLinks: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(updateTestCase).mockResolvedValue(fakeDetail() as never);
});

describe("updateTestCaseProcedure", () => {
	it("is gated on TEST_CASE_UPDATE", () => {
		expect(
			(updateTestCaseProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("test-case:update");
	});

	it("forwards the automation link to the query layer, which owns the AUTOMATED rule", async () => {
		await handler({
			input: {
				projectId: "p1",
				testCaseId: "tc1",
				organizationId: null,
				automationRef: "login.spec.ts > signs in",
				automationFilePath: "apps/web/tests/e2e/login.spec.ts",
				automationExternalUrl: "https://ci.example.com/run/1",
			},
			context: ctx,
		});

		expect(updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "tc1",
				projectId: "p1",
				data: expect.objectContaining({
					automationRef: "login.spec.ts > signs in",
					automationFilePath: "apps/web/tests/e2e/login.spec.ts",
					automationExternalUrl: "https://ci.example.com/run/1",
				}),
			}),
		);
	});

	it("passes an explicit automationStatus through alongside a ref (the PLANNED escape hatch)", async () => {
		await handler({
			input: {
				projectId: "p1",
				testCaseId: "tc1",
				organizationId: null,
				automationRef: "login.spec.ts > signs in",
				automationStatus: "PLANNED",
			},
			context: ctx,
		});

		const data = vi.mocked(updateTestCase).mock.calls[0][0].data;
		expect(data.automationStatus).toBe("PLANNED");
		expect(data.automationRef).toBe("login.spec.ts > signs in");
	});

	it("forwards a cleared ref so the query layer can null it", async () => {
		await handler({
			input: {
				projectId: "p1",
				testCaseId: "tc1",
				organizationId: null,
				automationRef: "",
			},
			context: ctx,
		});
		expect(
			vi.mocked(updateTestCase).mock.calls[0][0].data.automationRef,
		).toBe("");
	});

	it("throws NOT_FOUND when the case does not exist in the project", async () => {
		vi.mocked(updateTestCase).mockResolvedValue(null as never);
		await expect(
			handler({
				input: {
					projectId: "p1",
					testCaseId: "missing",
					organizationId: null,
					title: "X",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
