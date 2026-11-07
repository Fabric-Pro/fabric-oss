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
		frameApprovedRevision: {
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn(async ({ data }) => ({ id: data.id, ...data })),
		},
		member: { findFirst: vi.fn().mockResolvedValue({ role: "owner" }) },
		$queryRaw: vi.fn().mockResolvedValue([]),
		auditLog: {
			create: vi.fn().mockResolvedValue({ id: "example-audit" }),
		},
		agentWorkspaceFile: {
			findFirst: mocks.findFrame,
			update: mocks.updateFile,
		},
		organization: { findUnique: mocks.findOrganization },
		frameEditHistory: { create: mocks.historyCreate },
	};
	mocks.transaction.mockImplementation(
		async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
	);
	return {
		...actual,
		db: {
			...tx,
			agentWorkspaceFile: {
				findFirst: mocks.findFrame,
				findUnique: mocks.findFrame,
				create: mocks.createFile,
				update: mocks.updateFile,
			},
			organization: { findUnique: mocks.findOrganization },
			$transaction: mocks.transaction,
		},
	};
});

import { PUBLIC_SHARING_DISABLED_MESSAGE } from "../prisma/queries/frame-share";
import { checkFrameAccess } from "../prisma/queries/frame-sharing";
import {
	createFrame,
	getFrameByShareToken,
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
	mocks.updateFile.mockImplementation(async ({ data }) => {
		const updated = { ...ROW, ...data };
		mocks.findFrame.mockResolvedValue(updated);
		return updated;
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

		// First pin the legacy public snapshot, then save the draft. Both are transactional.
		expect(mocks.updateFile).toHaveBeenCalledTimes(2);
		expect(
			mocks.updateFile.mock.calls[0][0].data.metadata
				.publishedFrameRevisionId,
		).toMatch(/^frame-approved-/);
		expect(mocks.updateFile.mock.calls[1][0].data.content).toBeDefined();
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

describe("frame update timestamp fence", () => {
	it("checks the requested timestamp immediately before versioning", async () => {
		await expect(
			updateFrame({
				id: ROW.id,
				userId: ROW.userId,
				organizationId: ROW.organizationId,
				expectedUpdatedAt: ROW.updatedAt,
				requestedUpdatedAt: new Date(0),
				title: "Example",
			}),
		).rejects.toThrow("Reload");
		expect(mocks.historyCreate).not.toHaveBeenCalled();
		expect(mocks.updateFile).not.toHaveBeenCalled();
	});
	it("uses the read timestamp in the conditional write and reports a conflict on a concurrent change", async () => {
		mocks.updateFile.mockRejectedValueOnce({ code: "P2025" });
		await expect(
			updateFrame({
				id: ROW.id,
				userId: ROW.userId,
				organizationId: ROW.organizationId,
				expectedUpdatedAt: ROW.updatedAt,
				title: "Example",
			}),
		).rejects.toThrow("Reload");
		expect(mocks.updateFile).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ updatedAt: ROW.updatedAt }),
			}),
		);
	});
	it("does not add history for unchanged content", async () => {
		mocks.findFrame.mockResolvedValue({
			...ROW,
			content: JSON.stringify(JSON.parse(ROW.content), null, 2),
		});
		await updateFrame({
			id: ROW.id,
			userId: ROW.userId,
			organizationId: ROW.organizationId,
			expectedUpdatedAt: ROW.updatedAt,
		});
		expect(mocks.historyCreate).not.toHaveBeenCalled();
	});
});

describe("live public sharing policy on reads", () => {
	beforeEach(() =>
		mocks.findFrame.mockResolvedValue({
			...ROW,
			isPublic: true,
			shareScope: "PUBLIC",
			shareToken: "example-bearer",
		}),
	);
	it("refuses an existing bearer and ID-based public read when policy is disabled", async () => {
		organizationAllowsPublicLinks(false);
		expect(await getFrameByShareToken("example-bearer")).toBeNull();
		expect(
			await checkFrameAccess({
				frameId: ROW.id,
				userId: "example-viewer",
			}),
		).toMatchObject({ hasAccess: false });
	});
	it("retains a legacy bearer only while its current organization policy allows it", async () => {
		organizationAllowsPublicLinks(true);
		expect(await getFrameByShareToken("example-bearer")).toMatchObject({
			id: ROW.id,
		});
		expect(
			await checkFrameAccess({
				frameId: ROW.id,
				userId: "example-viewer",
			}),
		).toMatchObject({ hasAccess: true });
		expect(mocks.findOrganization).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: ROW.organizationId, deletedAt: null },
			}),
		);
	});
	it("refuses a missing or deleted organization and keeps the owner's private read", async () => {
		mocks.findOrganization.mockResolvedValue(null);
		expect(await getFrameByShareToken("example-bearer")).toBeNull();
		expect(
			await checkFrameAccess({ frameId: ROW.id, userId: ROW.userId }),
		).toMatchObject({ hasAccess: true });
	});
});

describe("legacy public admission without an organization", () => {
	beforeEach(() => {
		mocks.findFrame.mockResolvedValue({ ...ROW, organizationId: null });
		organizationAllowsPublicLinks(true);
	});
	it("refuses creation of a public orphan Frame before writing a token", async () => {
		await expect(
			createFrame({
				userId: ROW.userId,
				title: "Example orphan",
				blocks: BLOCKS,
				isPublic: true,
			}),
		).rejects.toMatchObject({ name: "PublicSharingDisabledError" });
		expect(mocks.createFile).not.toHaveBeenCalled();
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
	it("refuses a legacy public update of an orphan Frame", async () => {
		await expect(
			updateFrame({ id: ROW.id, userId: ROW.userId, isPublic: true }),
		).rejects.toMatchObject({ name: "PublicSharingDisabledError" });
		expect(mocks.updateFile).not.toHaveBeenCalled();
		expect(mocks.historyCreate).not.toHaveBeenCalled();
	});
	it("refuses publication of an orphan Frame through the legacy adapter", async () => {
		expect(
			await publishFrame({ id: ROW.id, userId: ROW.userId }),
		).toBeNull();
		expect(mocks.updateFile).not.toHaveBeenCalled();
	});
	it("preserves private legacy creation without granting public access", async () => {
		await createFrame({
			userId: ROW.userId,
			title: "Example private orphan",
			blocks: BLOCKS,
		});
		expect(mocks.createFile).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					organizationId: null,
					isPublic: false,
					shareToken: null,
				}),
			}),
		);
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
});
