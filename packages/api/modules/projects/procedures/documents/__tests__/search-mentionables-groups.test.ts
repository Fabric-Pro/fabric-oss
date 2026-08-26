/**
 * Group candidates in `searchMentionablesProcedure` (#1767 Stage 5, Task 9).
 *
 * Additive to the existing member search (see the sibling
 * `procedures/__tests__/search-mentionables.test.ts`, which locks `members`
 * unchanged): `groups` stays `[]` when the function-tags flag is OFF, and
 * surfaces all 8 `FUNCTION_TAG_ORDER` entries (with roster-derived
 * `memberCount`) when ON, narrowed by `query` the same way `members` is.
 *
 * `computeGroupMemberCounts` is left un-mocked (spread from `actual`) so the
 * roster case exercises the real pure combinator — mirrors the sibling
 * `function-tags/procedures/__tests__/group-member-counts.test.ts` harness.
 * `db` (projectDocument/project/projectMember/user) is stubbed the same way
 * as `procedures/__tests__/search-mentionables.test.ts`.
 *
 * Run with:
 *   NODE_OPTIONS=--max-old-space-size=8192 pnpm --filter @repo/api test modules/projects/procedures/documents/__tests__/search-mentionables-groups.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mockDocumentFindUnique: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockProjectMemberFindMany: vi.fn(),
	mockUserFindMany: vi.fn(),
	getProjectMemberFunctionTags: vi.fn(),
	isFunctionTagsEnabled: vi.fn(),
	captured: {} as Record<
		string,
		(args: { context: unknown; input: unknown }) => Promise<unknown>
	>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: {
			projectDocument: {
				findUnique: (...args: unknown[]) =>
					mocks.mockDocumentFindUnique(...args),
			},
			project: {
				findUnique: (...args: unknown[]) =>
					mocks.mockProjectFindUnique(...args),
			},
			projectMember: {
				findMany: (...args: unknown[]) =>
					mocks.mockProjectMemberFindMany(...args),
			},
			user: {
				findMany: (...args: unknown[]) =>
					mocks.mockUserFindMany(...args),
			},
		},
		getProjectMemberFunctionTags: mocks.getProjectMemberFunctionTags,
	};
});

vi.mock("@repo/utils/feature-flag", () => ({
	isFunctionTagsEnabled: mocks.isFunctionTagsEnabled,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.captured.searchMentionables = fn as (args: {
				context: unknown;
				input: unknown;
			}) => Promise<unknown>;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
	};
});

// Side-effect: register the handler.
await import("../search-mentionables");

const ctx = { user: { id: "user_caller", email: "caller@example.com" } };

function user(id: string, name: string | null, email: string | null) {
	return { id, name, email, image: null };
}

const PROJECT_ID = "proj_1";
const DOCUMENT_ID = "doc_1";

function callInput(overrides: Partial<{ query: string }> = {}) {
	return {
		input: {
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			query: "",
			...overrides,
		},
		context: ctx,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.mockDocumentFindUnique.mockResolvedValue({ projectId: PROJECT_ID });
	mocks.mockProjectFindUnique.mockResolvedValue({
		id: PROJECT_ID,
		user: user("user_owner", "Owner", "owner@example.com"),
	});
	mocks.mockProjectMemberFindMany.mockResolvedValue([]);
	mocks.mockUserFindMany.mockResolvedValue([]);
});

describe("searchMentionablesProcedure — group candidates (#1767 Stage 5)", () => {
	it("flag OFF: groups is [] and members are unaffected", async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(false);
		mocks.mockProjectMemberFindMany.mockResolvedValue([
			{ userId: "user_pm" },
		]);
		mocks.mockUserFindMany.mockResolvedValue([
			user("user_pm", "Bob PM", "bob@example.com"),
		]);

		const result = (await mocks.captured.searchMentionables(
			callInput(),
		)) as { members: Array<{ id: string }>; groups: unknown[] };

		expect(result.groups).toEqual([]);
		expect(mocks.getProjectMemberFunctionTags).not.toHaveBeenCalled();
		expect(result.members.map((m) => m.id).sort()).toEqual([
			"user_owner",
			"user_pm",
		]);
	});

	it("flag ON: returns all 8 groups with correct label + memberCount from the roster", async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(true);
		mocks.getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "user_owner", tags: ["PRODUCT_OWNER"] },
			{ userId: "user_dev1", tags: ["DEVELOPER"] },
			{ userId: "user_dev2", tags: ["DEVELOPER", "SME"] },
		]);

		const result = (await mocks.captured.searchMentionables(
			callInput(),
		)) as {
			groups: Array<{
				kind: string;
				tag: string;
				label: string;
				memberCount: number;
			}>;
		};

		expect(
			mocks.getProjectMemberFunctionTags,
		).toHaveBeenCalledExactlyOnceWith(PROJECT_ID);
		expect(result.groups).toEqual([
			{
				kind: "group",
				tag: "PRODUCT_OWNER",
				label: "Product Owners",
				memberCount: 1,
			},
			{
				kind: "group",
				tag: "PRODUCT_CONTRIBUTOR",
				label: "Product Contributors",
				memberCount: 0,
			},
			{
				kind: "group",
				tag: "DEVELOPER",
				label: "Developers",
				memberCount: 2,
			},
			{
				kind: "group",
				tag: "ARCHITECT",
				label: "Architects",
				memberCount: 0,
			},
			{
				kind: "group",
				tag: "DESIGNER",
				label: "Designers",
				memberCount: 0,
			},
			{
				kind: "group",
				tag: "SDET_QA",
				label: "SDET/QA",
				memberCount: 0,
			},
			{
				kind: "group",
				tag: "SME",
				label: "SMEs",
				memberCount: 1,
			},
			{
				kind: "group",
				tag: "STAKEHOLDER",
				label: "Stakeholders",
				memberCount: 0,
			},
		]);
	});

	it('flag ON + query:"dev" narrows groups by label substring to only Developers', async () => {
		mocks.isFunctionTagsEnabled.mockReturnValue(true);
		mocks.getProjectMemberFunctionTags.mockResolvedValue([
			{ userId: "user_dev1", tags: ["DEVELOPER"] },
		]);

		const result = (await mocks.captured.searchMentionables(
			callInput({ query: "dev" }),
		)) as { groups: Array<{ tag: string; label: string }> };

		expect(result.groups).toEqual([
			{
				kind: "group",
				tag: "DEVELOPER",
				label: "Developers",
				memberCount: 1,
			},
		]);
	});
});
