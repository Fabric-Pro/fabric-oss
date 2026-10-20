import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	frame: vi.fn(),
	access: vi.fn(),
	project: vi.fn(),
	options: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getAccessibleFrameById: mocks.frame,
	hasProjectAccess: mocks.access,
	db: { project: { findFirst: mocks.project } },
}));
vi.mock("@repo/api/modules/ai-config/lib/review-selector-options", async () => {
	const { z } = await import("zod");
	return {
		listReviewSelectorOptions: mocks.options,
		reviewSelectorPageSchema: z.object({
			limit: z.number().int().min(1).max(50).default(25),
		}),
	};
});

import { handleGetReviewOptions } from "../tools/page-review-options";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "viewer-1",
	organizationId: "org-1",
	userName: "Example Viewer",
	email: "viewer@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01"),
	expiresAt: new Date("2026-01-02"),
};
const frame = {
	id: "workspace-1",
	organizationId: "org-1",
	surface: "workspace",
	projectId: "project-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.frame.mockResolvedValue(frame);
	mocks.access.mockResolvedValue(true);
	mocks.project.mockResolvedValue({
		id: "project-1",
		name: "Example Project",
	});
	mocks.options.mockResolvedValue({
		models: { items: [], hasMore: false, nextOffset: null },
	});
});

describe("Workspace review option boundary", () => {
	it("derives caller, organization and project from the authorized Workspace", async () => {
		const result = await handleGetReviewOptions(
			{ frameId: "workspace-1", limit: 3 },
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(mocks.frame).toHaveBeenCalledWith({
			id: "workspace-1",
			userId: "viewer-1",
			userEmail: "viewer@example.com",
			organizationId: "org-1",
		});
		expect(mocks.access).toHaveBeenCalledWith("project-1", "viewer-1");
		expect(mocks.project).toHaveBeenCalledWith({
			where: {
				id: "project-1",
				organizationId: "org-1",
				deletedAt: null,
			},
			select: { id: true, name: true },
		});
		expect(mocks.options).toHaveBeenCalledWith(
			{ userId: "viewer-1", organizationId: "org-1" },
			{ frameId: "workspace-1", limit: 3 },
		);
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			project: { id: "project-1", label: "Example Project" },
		});
	});

	it.each([
		{ projectId: "foreign-project" },
		{ organizationId: "foreign-org" },
		{ viewer: { userId: "owner-1" } },
		{ collection: "binding" },
		{ limit: 51 },
	])(
		"refuses caller-supplied bindings or invalid pagination before frame/data lookup",
		async (args) => {
			expect(
				(
					await handleGetReviewOptions(
						{ frameId: "workspace-1", ...args },
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.frame).not.toHaveBeenCalled();
			expect(mocks.options).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		{ ...frame, organizationId: "foreign-org" },
		{ ...frame, surface: "artifact" },
		{ ...frame, projectId: null },
	])(
		"refuses inaccessible, foreign-tenant or unbound non-Workspace frames",
		async (record) => {
			mocks.frame.mockResolvedValueOnce(record);
			expect(
				(
					await handleGetReviewOptions(
						{ frameId: "workspace-1" },
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.options).not.toHaveBeenCalled();
		},
	);

	it("refuses revoked project access, a trashed project or a pinned foreign project", async () => {
		mocks.access.mockResolvedValueOnce(false);
		expect(
			(await handleGetReviewOptions({ frameId: "workspace-1" }, session))
				.isError,
		).toBe(true);
		mocks.project.mockResolvedValueOnce(null);
		expect(
			(await handleGetReviewOptions({ frameId: "workspace-1" }, session))
				.isError,
		).toBe(true);
		expect(
			(
				await handleGetReviewOptions(
					{ frameId: "workspace-1" },
					{ ...session, pinnedProjectId: "other-project" },
				)
			).isError,
		).toBe(true);
		expect(mocks.options).not.toHaveBeenCalled();
	});

	it("keeps selector authorization failures free of provider or credential details", async () => {
		mocks.options.mockRejectedValueOnce(
			new Error("private provider detail"),
		);
		const result = await handleGetReviewOptions(
			{ frameId: "workspace-1" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private provider detail");
	});
});
