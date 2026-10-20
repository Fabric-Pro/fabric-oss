/**
 * Every command that can set a frame public (`publishFrame`, `createFrame`
 * with `isPublic`, `updateFrame` with `isPublic`) applies the organization's
 * public-link policy before it writes, with the rule `shareFrame` applies
 * (`assertPublicSharingAllowed`). A caller that forgot the check cannot
 * publish: the command refuses.
 *
 * The store is faked; what these cases assert on is whether anything was
 * written.
 *
 * Run with: pnpm --filter @repo/database test __tests__/frame-public-guard
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFrame: vi.fn(),
	createFile: vi.fn(),
	updateFile: vi.fn(),
	findOrganization: vi.fn(),
	transaction: vi.fn(),
	historyCreate: vi.fn(),
}));

vi.mock("../prisma/client", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prisma/client")>();
	const tx = {
		agentWorkspaceFile: { update: mocks.updateFile },
		frameEditHistory: { create: mocks.historyCreate },
	};
	mocks.transaction.mockImplementation(
		async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
	);
	return {
		...actual,
		db: {
			agentWorkspaceFile: {
				findFirst: mocks.findFrame,
				create: mocks.createFile,
				update: mocks.updateFile,
			},
			organization: { findUnique: mocks.findOrganization },
			$transaction: mocks.transaction,
		},
	};
});

import { PUBLIC_SHARING_DISABLED_MESSAGE } from "../prisma/queries/frame-share";
import {
	createFrame,
	publishFrame,
	updateFrame,
} from "../prisma/queries/frames";

const ROW = {
	id: "frame-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: null,
	conversationId: null,
	name: "Plan.frame.json",
	path: "frames/plan.frame.json",
	content: JSON.stringify({
		version: 1,
		kind: "frame",
		title: "Plan",
		blocks: [{ id: "block-1", type: "markdown", content: "# Plan" }],
		metadata: {},
	}),
	isPublic: false,
	shareToken: null,
	shareScope: "PRIVATE",
	fileType: "FRAME",
	mimeType: "application/vnd.fabric.frame",
	metadata: {},
	description: null,
	providerKeys: [],
	createdAt: new Date("2026-10-01T00:00:00Z"),
	updatedAt: new Date("2026-10-01T00:00:00Z"),
};

const BLOCKS = [
	{ id: "block-1", type: "markdown" as const, content: "# Plan" },
];

function organizationAllowsPublicLinks(allowed: boolean) {
	mocks.findOrganization.mockResolvedValue({
		canShareFramesPublicly: allowed,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findFrame.mockResolvedValue(ROW);
	mocks.createFile.mockResolvedValue({
		...ROW,
		isPublic: true,
		shareToken: "t",
	});
	mocks.updateFile.mockResolvedValue({
		...ROW,
		isPublic: true,
		shareToken: "t",
	});
	mocks.historyCreate.mockResolvedValue({});
});

describe("publishFrame", () => {
	it("refuses where the organization does not allow public links, and writes nothing", async () => {
		organizationAllowsPublicLinks(false);

		await expect(
			publishFrame({
				id: "frame-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).rejects.toMatchObject({
			name: "PublicSharingDisabledError",
			message: PUBLIC_SHARING_DISABLED_MESSAGE,
		});
		expect(mocks.updateFile).not.toHaveBeenCalled();
	});

	it("publishes where the organization allows it", async () => {
		organizationAllowsPublicLinks(true);

		const frame = await publishFrame({
			id: "frame-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		expect(frame).toMatchObject({ isPublic: true });
		expect(mocks.updateFile).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ isPublic: true }),
			}),
		);
	});

	it("still says a frame that is not the caller's is not found, without asking the policy", async () => {
		mocks.findFrame.mockResolvedValue(null);

		expect(
			await publishFrame({
				id: "frame-1",
				userId: "user-1",
				organizationId: "org-1",
			}),
		).toBeNull();
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
});

describe("createFrame", () => {
	it("refuses a public frame where the organization does not allow public links, and writes nothing", async () => {
		organizationAllowsPublicLinks(false);

		await expect(
			createFrame({
				userId: "user-1",
				organizationId: "org-1",
				title: "Plan",
				blocks: BLOCKS,
				isPublic: true,
			}),
		).rejects.toMatchObject({ name: "PublicSharingDisabledError" });
		expect(mocks.createFile).not.toHaveBeenCalled();
	});

	it("creates a public frame where the organization allows it", async () => {
		organizationAllowsPublicLinks(true);

		await createFrame({
			userId: "user-1",
			organizationId: "org-1",
			title: "Plan",
			blocks: BLOCKS,
			isPublic: true,
		});

		expect(mocks.createFile).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ isPublic: true }),
			}),
		);
	});

	it("creates a private frame without consulting the policy", async () => {
		await createFrame({
			userId: "user-1",
			organizationId: "org-1",
			title: "Plan",
			blocks: BLOCKS,
		});

		expect(mocks.findOrganization).not.toHaveBeenCalled();
		expect(mocks.createFile).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					isPublic: false,
					shareToken: null,
				}),
			}),
		);
	});
});

describe("updateFrame", () => {
	it("refuses to make a private frame public where the organization does not allow it, and writes nothing", async () => {
		organizationAllowsPublicLinks(false);

		await expect(
			updateFrame({
				id: "frame-1",
				userId: "user-1",
				organizationId: "org-1",
				isPublic: true,
			}),
		).rejects.toMatchObject({ name: "PublicSharingDisabledError" });
		expect(mocks.updateFile).not.toHaveBeenCalled();
	});

	it("makes a private frame public where the organization allows it", async () => {
		organizationAllowsPublicLinks(true);

		await updateFrame({
			id: "frame-1",
			userId: "user-1",
			organizationId: "org-1",
			isPublic: true,
		});

		expect(mocks.updateFile).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ isPublic: true }),
			}),
		);
	});

	it("does not refuse an edit that re-sends public for a frame that already is, whatever the policy now says", async () => {
		organizationAllowsPublicLinks(false);
		mocks.findFrame.mockResolvedValue({
			...ROW,
			isPublic: true,
			shareToken: "t",
		});

		await updateFrame({
			id: "frame-1",
			userId: "user-1",
			organizationId: "org-1",
			title: "Plan v2",
			isPublic: true,
		});

		expect(mocks.updateFile).toHaveBeenCalledTimes(1);
	});

	it("does not consult the policy for an edit that does not touch visibility", async () => {
		await updateFrame({
			id: "frame-1",
			userId: "user-1",
			organizationId: "org-1",
			title: "Plan v2",
		});

		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
});
