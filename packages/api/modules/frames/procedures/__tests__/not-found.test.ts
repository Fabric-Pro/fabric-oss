/**
 * A frame the caller cannot reach in the resolved organization (missing,
 * another organization's, or gone between the lookup and the write) answers
 * NOT_FOUND, the way `frames.get` does, never a 500.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/not-found.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<unknown>;

type Chain = {
	use: () => Chain;
	route: (route: { method: string; path: string }) => Chain;
	input: () => Chain;
	output: () => Chain;
	handler: (fn: Handler) => { _handler: Handler };
};

const { handlers, db } = vi.hoisted(() => ({
	handlers: {} as Record<string, Handler>,
	db: {
		getFrameById: vi.fn(),
		deleteFrame: vi.fn(),
		countPageRecords: vi.fn(),
		duplicateFrame: vi.fn(),
		updateFrame: vi.fn(),
		publishFrame: vi.fn(),
		revokeFrameShare: vi.fn(),
		getFrameEditHistory: vi.fn(),
		listSharingGrants: vi.fn(),
	},
}));

vi.mock("@repo/database", () => {
	class FramePlacementRefusedError extends Error {}
	class PublicSharingDisabledError extends Error {}
	return { ...db, FramePlacementRefusedError, PublicSharingDisabledError };
});

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/storage", () => ({
	deleteFramePageFiles: vi.fn(),
}));

vi.mock("../../lib/page-files", () => ({
	PAGE_FILES_BUCKET: "page-files",
}));

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: Chain = {
		use: () => chainable,
		route: (route) => {
			current = `${route.method} ${route.path}`;
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import { FramePlacementRefusedError } from "@repo/database";
import "../delete";
import "../duplicate";
import "../get-history";
import "../list-grants";
import "../publish";
import "../revoke-share";
import "../update";

const run = (route: string, input: Record<string, unknown> = {}) =>
	handlers[route]({
		input: { id: "frame-1", organizationId: "org-1", ...input },
		context: { user: { id: "user-1" }, session: {} },
	});

const expectNotFound = async (promise: Promise<unknown>) => {
	const error = await promise.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(ORPCError);
	expect(error).toMatchObject({
		code: "NOT_FOUND",
		status: 404,
		message: "Frame not found",
	});
};

const FRAME = { id: "frame-1", userId: "user-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("frames.delete", () => {
	it("answers NOT_FOUND when the frame is not in the resolved organization", async () => {
		db.getFrameById.mockResolvedValue(null);

		await expectNotFound(run("DELETE /frames/{id}"));

		expect(db.getFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(db.countPageRecords).not.toHaveBeenCalled();
		expect(db.deleteFrame).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the frame is gone before the delete", async () => {
		db.getFrameById.mockResolvedValue(FRAME);
		db.countPageRecords.mockResolvedValue(0);
		db.deleteFrame.mockResolvedValue({
			success: false,
			error: "Frame not found",
		});

		await expectNotFound(run("DELETE /frames/{id}"));
	});

	it("still deletes a frame it finds", async () => {
		db.getFrameById.mockResolvedValue(FRAME);
		db.countPageRecords.mockResolvedValue(0);
		db.deleteFrame.mockResolvedValue({ success: true });

		await expect(run("DELETE /frames/{id}")).resolves.toEqual({
			success: true,
		});
	});
});

describe("frames.duplicate", () => {
	it("answers NOT_FOUND when the original is not in the resolved organization", async () => {
		db.getFrameById.mockResolvedValue(null);

		await expectNotFound(run("POST /frames/{id}/duplicate"));

		expect(db.duplicateFrame).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the project refuses the copy", async () => {
		db.getFrameById.mockResolvedValue(FRAME);
		db.duplicateFrame.mockRejectedValue(new FramePlacementRefusedError());

		await expectNotFound(run("POST /frames/{id}/duplicate"));
	});
});

describe.each([
	["frames.update", "POST /frames/{id}", db.updateFrame],
	["frames.publish", "POST /frames/{id}/publish", db.publishFrame],
	[
		"frames.revokeShare",
		"POST /frames/{id}/revoke-share",
		db.revokeFrameShare,
	],
	["frames.getHistory", "GET /frames/{id}/history", db.getFrameById],
	["frames.listGrants", "GET /frames/{id}/grants", db.getFrameById],
])("%s", (_name, route, lookup) => {
	it("answers NOT_FOUND when the frame is not in the resolved organization", async () => {
		lookup.mockResolvedValue(null);

		await expectNotFound(run(route));

		expect(lookup).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});
});
