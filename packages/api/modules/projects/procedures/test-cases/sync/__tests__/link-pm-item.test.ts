/**
 * `projects.testCases.sync.linkPmItem`: declares TEST_CASE_UPDATE, is off
 * with the Test Cases feature, gates on the connected tool's live test-case
 * push support (like the case's retry), and hands the case to the shared
 * `linkPmItem` (covered in `lib/__tests__/link-pm-item.test.ts`).
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const mocks = vi.hoisted(() => ({
	linkPmItem: vi.fn(),
	assertTestCaseSyncSupported: vi.fn(),
}));

vi.mock("../../../../lib/link-pm-item", () => ({
	linkPmItem: mocks.linkPmItem,
}));
vi.mock("../../../../lib/pm-test-case-sync-capability", () => ({
	assertTestCaseSyncSupported: mocks.assertTestCaseSyncSupported,
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
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
			TEST_CASE_READ: "test-case:read",
			TEST_CASE_UPDATE: "test-case:update",
		},
	};
});

import { linkTestCasePmItemProcedure } from "../link-pm-item";

const proc = linkTestCasePmItemProcedure as unknown as {
	handler: (ctx: { input: unknown; context: unknown }) => Promise<unknown>;
	__permission: string;
	__input: z.ZodTypeAny;
};

const input = { projectId: "p1", testCaseId: "tc1", externalId: "1234" };
const context = { user: { id: "user-1" } };

beforeEach(() => {
	mocks.linkPmItem.mockReset();
	mocks.assertTestCaseSyncSupported.mockReset();
	mocks.linkPmItem.mockResolvedValue({
		linked: true,
		externalId: "1234",
		externalUrl: null,
	});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("linkTestCasePmItemProcedure", () => {
	it("declares TEST_CASE_UPDATE as the permission its middleware checks", () => {
		expect(proc.__permission).toBe("test-case:update");
	});

	it("trims the id and refuses an empty or over-long one", () => {
		const base = { projectId: "p1", testCaseId: "tc1" };
		expect(
			proc.__input.parse({ ...base, externalId: " 1234 " }).externalId,
		).toBe("1234");
		expect(
			proc.__input.safeParse({ ...base, externalId: "" }).success,
		).toBe(false);
		expect(
			proc.__input.safeParse({ ...base, externalId: "1".repeat(201) })
				.success,
		).toBe(false);
	});

	it("is not found while the Test Cases feature is off", async () => {
		vi.stubEnv("FABRIC_FEATURE_TEST_CASES", "false");

		await expect(proc.handler({ input, context })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.linkPmItem).not.toHaveBeenCalled();
	});

	it("links the case and gates the resolved target on test-case push support", async () => {
		const res = await proc.handler({ input, context });

		expect(res).toEqual({
			linked: true,
			externalId: "1234",
			externalUrl: null,
		});
		const args = mocks.linkPmItem.mock.calls[0][0];
		expect(args).toMatchObject({
			row: { testCaseId: "tc1" },
			projectId: "p1",
			externalId: "1234",
			userId: "user-1",
		});
		const target = { kind: "rest-gitlab", mcpConfigId: null };
		await args.assertTargetSupported(target, "org-1");
		expect(mocks.assertTestCaseSyncSupported).toHaveBeenCalledWith(
			target,
			"push",
			{ userId: "user-1", organizationId: "org-1" },
		);
	});

	it("passes the capability gate's refusal through", async () => {
		mocks.assertTestCaseSyncSupported.mockRejectedValue(
			new ORPCError("BAD_REQUEST", { message: "not supported" }),
		);
		mocks.linkPmItem.mockImplementation(
			async (a: {
				assertTargetSupported: (t: unknown, o: null) => Promise<void>;
			}) => {
				await a.assertTargetSupported({ kind: "mcp" }, null);
				return { linked: true, externalId: "1234", externalUrl: null };
			},
		);

		await expect(proc.handler({ input, context })).rejects.toMatchObject({
			message: "not supported",
		});
	});
});
