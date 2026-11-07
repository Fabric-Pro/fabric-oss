import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	visible: vi.fn(),
	stories: vi.fn(),
	contexts: vi.fn(),
	decisions: vi.fn(),
	documents: vi.fn(),
	servers: vi.fn(),
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.visible,
	db: {
		projectRemoteAgentServer: { findMany: mocks.servers },
		userStory: { findMany: mocks.stories },
		projectContext: { findMany: mocks.contexts },
		architectureDecision: { findMany: mocks.decisions },
		projectDocument: { findMany: mocks.documents },
	},
}));

import { getProjectDeliverySnapshot } from "../delivery-snapshot";

const actor = { userId: "example-user", organizationId: "example-org" };
const date = new Date("2026-11-01T00:00:00Z");
beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({
		organizationId: "example-org",
		permissions: Object.values(Permissions),
	});
	mocks.visible.mockResolvedValue(true);
	mocks.stories.mockResolvedValue([]);
	mocks.contexts.mockResolvedValue([]);
	mocks.decisions.mockResolvedValue([]);
	mocks.documents.mockResolvedValue([]);
	mocks.servers.mockResolvedValue([]);
});
describe("project delivery evidence", () => {
	it("does not query evidence for a hidden or cross-tenant project", async () => {
		mocks.visible.mockResolvedValue(false);
		await expect(
			getProjectDeliverySnapshot(actor, { projectId: "example-project" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.stories).not.toHaveBeenCalled();
		mocks.visible.mockResolvedValue(true);
		mocks.access.mockResolvedValue({
			organizationId: "other-org",
			permissions: Object.values(Permissions),
		});
		await expect(
			getProjectDeliverySnapshot(actor, { projectId: "example-project" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.contexts).not.toHaveBeenCalled();
	});
	it("distinguishes PR merge from unknown deployment and unreported external cost", async () => {
		mocks.stories.mockResolvedValue([
			{
				id: "example-story",
				identifier: "US-1",
				title: "Deliver the feature",
				draftingStage: "PUBLISHED",
				sourceRef: "REQ-1",
				dependsOnRefs: ["REQ-0"],
				updatedAt: date,
				tasks: [],
				codingRuns: [
					{
						id: "example-run",
						projectId: "example-project",
						providerMetadata: {
							executionTarget: {
								connectionId: "example-private",
							},
							secret: "private-credential",
						},
						storyTaskId: null,
						status: "COMPLETED",
						kind: "IMPLEMENT",
						createdAt: date,
						startedAt: date,
						mergedAt: date,
						pullRequestNumber: 1,
					},
				],
			},
		]);
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(mocks.servers).toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toMatch(
			/providerMetadata|private-credential|example-private/,
		);
		expect(result.work.items[0].runs[0]).toMatchObject({
			deliveryEvidence: "PR_MERGED",
			deployment: "UNKNOWN",
		});
		expect(result.limitations).toMatchObject({
			externalAgentCost: "NOT_REPORTED",
			leadTime: "NOT_COMPUTED",
			relationships: "EXPLICIT_REFERENCES_ONLY",
		});
	});
	it("flags completed extraction with an indexing error without exposing private error text", async () => {
		mocks.contexts.mockResolvedValue([
			{
				id: "example-source",
				type: "LINK",
				sourceTitle: "Project handbook",
				originalFilename: null,
				extractionStatus: "COMPLETED",
				extractionError: "private runtime connection detail",
				indexingExcluded: false,
				updatedAt: date,
				urlLastSyncedAt: null,
			},
		]);
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(result.context.sources[0]).toMatchObject({
			state: "NEEDS_ATTENTION",
			lastSyncedAt: null,
		});
		expect(result.nextAction.kind).toBe("REVIEW_CONTEXT");
		expect(JSON.stringify(result)).not.toContain("private runtime");
	});
	it("makes unavailable work/context explicit rather than treating it as zero evidence", async () => {
		mocks.access.mockResolvedValue({
			organizationId: "example-org",
			permissions: [Permissions.PROJECT_READ],
		});
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(result.work.available).toBe(false);
		expect(result.context.available).toBe(false);
		expect(result.decisions).toEqual({ available: false, items: [] });
		expect(result.documents).toEqual({ available: false, items: [] });
		expect(mocks.documents).not.toHaveBeenCalled();
		expect(mocks.decisions).not.toHaveBeenCalled();
		expect(mocks.stories).not.toHaveBeenCalled();
		expect(mocks.contexts).not.toHaveBeenCalled();
	});
	it("distinguishes stored extraction from an observed successful index", async () => {
		mocks.contexts.mockResolvedValue(
			[null, date].map((embeddedAt, i) => ({
				id: `example-source-${i}`,
				type: "LINK",
				sourceTitle: "Project brief",
				originalFilename: null,
				extractionStatus: "COMPLETED",
				extractionError: null,
				embeddedAt,
				indexingExcluded: false,
				updatedAt: date,
				urlLastSyncedAt: null,
			})),
		);
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(result.context.sources.map((source) => source.state)).toEqual([
			"STORED",
			"INDEXED",
		]);
		expect(result.context.indexed).toBe(1);
	});
	it("keeps run evidence unavailable when work is readable but agent access is not", async () => {
		mocks.access.mockResolvedValue({
			organizationId: "example-org",
			permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
		});
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(result.work).toMatchObject({
			available: true,
			runsAvailable: false,
		});
		expect(result.nextAction.kind).not.toBe("ADD_CONTEXT");
		expect(mocks.stories.mock.calls[0][0].select).not.toHaveProperty(
			"codingRuns",
		);
	});
	it("distinguishes permitted empty decisions/documents from unreadable sections", async () => {
		const result = await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(result.decisions).toEqual({ available: true, items: [] });
		expect(result.documents).toEqual({ available: true, items: [] });
		expect(mocks.documents).toHaveBeenCalledOnce();
		expect(mocks.decisions).toHaveBeenCalledOnce();
	});
	it("bounds work and context reads", async () => {
		await getProjectDeliverySnapshot(actor, {
			projectId: "example-project",
		});
		expect(mocks.stories).toHaveBeenCalledWith(
			expect.objectContaining({ take: 21 }),
		);
		expect(mocks.contexts).toHaveBeenCalledWith(
			expect.objectContaining({
				take: 101,
				where: {
					projectId: "example-project",
					organizationId: "example-org",
				},
			}),
		);
	});
});
