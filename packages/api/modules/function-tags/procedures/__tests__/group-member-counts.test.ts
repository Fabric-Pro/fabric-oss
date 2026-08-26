/**
 * Tests for the `functionTags.groupMemberCounts` oRPC procedure (#1767
 * Stage 5, Task 4) — the data source for the client-side "Notify N people?"
 * large-group confirm gate.
 *
 * Same harness as the sibling `project.test.ts` (Task 7): stub
 * `../../../../orpc/procedures` so `.handler(...)` can be captured and
 * invoked directly, and mock the `@repo/database` helpers the procedure
 * imports (`getProjectMemberFunctionTags`, `hasProjectAccess`) plus
 * `isFunctionTagsEnabled` from `@repo/utils/feature-flag`.
 * `computeGroupMemberCounts` is left un-mocked (spread from `actual`) so the
 * roster case exercises the real pure combinator.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/function-tags/procedures/__tests__/group-member-counts.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getProjectMemberFunctionTags: vi.fn(),
	hasProjectAccess: vi.fn(),
	isFunctionTagsEnabled: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: any; input: any }) => Promise<any>
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getProjectMemberFunctionTags: mocks.getProjectMemberFunctionTags,
		hasProjectAccess: mocks.hasProjectAccess,
	};
});

vi.mock("@repo/utils/feature-flag", () => ({
	isFunctionTagsEnabled: mocks.isFunctionTagsEnabled,
}));

// Stub the procedure builder so we can extract the raw handler. `.input()`,
// `.output()`, and `.route()` are intentionally no-ops here — see file header.
vi.mock("../../../../orpc/procedures", () => {
	let pendingKey = "";
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured[pendingKey] = fn as any;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
		__setPendingHandlerKey(key: string) {
			pendingKey = key;
		},
	};
});

const procedures = await import("../../../../orpc/procedures");
const setSlot = (
	procedures as unknown as { __setPendingHandlerKey: (key: string) => void }
).__setPendingHandlerKey;

setSlot("groupMemberCounts");
await import("../group-member-counts");

const PROJECT_ID = "proj-1";
const baseCtx = {
	user: { id: "user-1", email: "alice@example.com", name: "Alice" },
	session: {
		id: "sess-1",
		activeOrganizationId: "org-SESSION",
		impersonatedBy: null,
	},
	headers: new Headers(),
};

beforeEach(() => {
	mocks.getProjectMemberFunctionTags.mockReset();
	mocks.hasProjectAccess.mockReset();
	mocks.isFunctionTagsEnabled.mockReset();
});

describe("groupMemberCountsProcedure", () => {
	it("returns {} and reads no roster when the flag is OFF", async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(false);

		const result = await mocks.captured.groupMemberCounts({
			context: baseCtx,
			input: { projectId: PROJECT_ID },
		});

		expect(result).toEqual({});
		expect(mocks.getProjectMemberFunctionTags).not.toHaveBeenCalled();
		expect(mocks.hasProjectAccess).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the flag is ON but hasProjectAccess is false", async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(true);
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			mocks.captured.groupMemberCounts({
				context: baseCtx,
				input: { projectId: PROJECT_ID },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mocks.hasProjectAccess).toHaveBeenCalledExactlyOnceWith(
			PROJECT_ID,
			baseCtx.user.id,
		);
		expect(mocks.getProjectMemberFunctionTags).not.toHaveBeenCalled();
	});

	it("returns computeGroupMemberCounts(roster) when the flag is ON and access is granted", async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(true);
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "owner-1", tags: [] },
			{ userId: "member-1", tags: ["DEVELOPER"] },
			{ userId: "member-2", tags: ["DEVELOPER", "SME"] },
		]);

		const result = await mocks.captured.groupMemberCounts({
			context: baseCtx,
			input: { projectId: PROJECT_ID },
		});

		expect(
			mocks.getProjectMemberFunctionTags,
		).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
		expect(result).toEqual({
			PRODUCT_OWNER: 0,
			PRODUCT_CONTRIBUTOR: 0,
			DEVELOPER: 2,
			ARCHITECT: 0,
			DESIGNER: 0,
			SDET_QA: 0,
			SME: 1,
			STAKEHOLDER: 0,
		});
	});
});
