/**
 * "Merge into this proposal", from the manual create dialog or from another
 * inbox item flagged as a duplicate: edit permission on the project is
 * required, and each outcome of the compare-and-set merge maps to its own
 * response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
	mocks: {
		canEdit: vi.fn(),
		merge: vi.fn(),
		mergeDuplicate: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	canEditProject: mocks.canEdit,
	MERGE_ADDITION_MAX_LENGTH: 10_000,
	mergeDuplicateInboxItem: mocks.mergeDuplicate,
	mergeIntoPendingProposalItem: mocks.merge,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.merge = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: (permission: string) => {
			uses.push({ requireProjectPermission: permission });
			return (c: unknown) => c;
		},
	};
});

await import("../merge-into-proposal-item");

const call = (user: Record<string, unknown> = { name: "Example Person" }) =>
	handlers.merge({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			proposalId: "prop-1",
			changeIndex: 1,
			description: "Also cap export size.",
		},
		context: { user: { id: "user-1", ...user } },
	});

async function errorFrom(promise: unknown) {
	try {
		await promise;
	} catch (error) {
		return error as { code?: string };
	}
	throw new Error("expected the handler to throw");
}

const callWithSource = () =>
	handlers.merge({
		input: {
			projectId: "project-1",
			organizationId: "org-1",
			proposalId: "prop-1",
			changeIndex: 1,
			source: { proposalId: "prop-2", changeIndex: 0 },
		},
		context: { user: { id: "user-1", name: "Example Person" } },
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.canEdit.mockResolvedValue(true);
	mocks.merge.mockResolvedValue({ outcome: "merged" });
	mocks.mergeDuplicate.mockResolvedValue({ outcome: "merged" });
});

describe("mergeIntoProposalItemProcedure — a duplicate inbox item", () => {
	it("merges the other item, read on the server, and names the target proposal", async () => {
		await expect(callWithSource()).resolves.toEqual({
			id: "prop-1",
			changeIndex: 1,
		});
		expect(mocks.mergeDuplicate).toHaveBeenCalledWith({
			projectId: "project-1",
			source: { proposalId: "prop-2", changeIndex: 0 },
			target: { proposalId: "prop-1", changeIndex: 1 },
			mergedBy: "user-1",
			mergedByName: "Example Person",
		});
		expect(mocks.merge).not.toHaveBeenCalled();
	});

	it("refuses a caller who cannot edit the project, before any write", async () => {
		mocks.canEdit.mockResolvedValue(false);

		expect((await errorFrom(callWithSource())).code).toBe("FORBIDDEN");
		expect(mocks.mergeDuplicate).not.toHaveBeenCalled();
	});

	it.each([
		["source_not_found", "NOT_FOUND"],
		["source_resolved", "CONFLICT"],
		["source_invalid", "BAD_REQUEST"],
		["same_item", "BAD_REQUEST"],
		["too_long", "BAD_REQUEST"],
		["conflict", "CONFLICT"],
	])("maps a %s merge to %s", async (outcome, code) => {
		mocks.mergeDuplicate.mockResolvedValue({ outcome });

		expect((await errorFrom(callWithSource())).code).toBe(code);
	});
});

describe("mergeIntoProposalItemProcedure", () => {
	it("merges the entry, attributed to the caller, and names the proposal", async () => {
		await expect(call()).resolves.toEqual({
			id: "prop-1",
			changeIndex: 1,
		});
		expect(mocks.merge).toHaveBeenCalledWith({
			projectId: "project-1",
			proposalId: "prop-1",
			changeIndex: 1,
			addition: "Also cap export size.",
			addedBy: "Example Person",
		});
		expect(uses).toContainEqual({
			requireProjectPermission: "project:update",
		});
	});

	it("leaves the attribution out when the caller has no name", async () => {
		await call({ name: "  " });

		expect(mocks.merge).toHaveBeenCalledWith(
			expect.objectContaining({ addedBy: null }),
		);
	});

	it("refuses a caller who cannot edit the project, before any write", async () => {
		mocks.canEdit.mockResolvedValue(false);

		expect((await errorFrom(call())).code).toBe("FORBIDDEN");
		expect(mocks.canEdit).toHaveBeenCalledWith("project-1", "user-1");
		expect(mocks.merge).not.toHaveBeenCalled();
	});

	it.each([
		["not_found", "NOT_FOUND"],
		["invalid_index", "BAD_REQUEST"],
		["too_long", "BAD_REQUEST"],
		["conflict", "CONFLICT"],
	])("maps a %s merge to %s", async (outcome, code) => {
		mocks.merge.mockResolvedValue({ outcome });

		expect((await errorFrom(call())).code).toBe(code);
	});

	it("tells the reviewer to create a new item when the merge is too long", async () => {
		mocks.merge.mockResolvedValue({ outcome: "too_long" });

		expect(await errorFrom(call())).toMatchObject({
			code: "BAD_REQUEST",
			message:
				"This proposal item is already too long to merge more text into. Create a new item instead.",
		});
	});
});
