import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MANUAL accept flow (§7.5). The DB writes are mocked; the real apply / combine /
 * split run so these tests assert the actual apply-and-clear vs. refuse behavior.
 */

const mocks = vi.hoisted(() => ({
	setDecisionMetadata: vi.fn(),
	getStoryById: vi.fn(),
	createFeatureVersion: vi.fn(),
	userStoryUpdate: vi.fn(),
	enqueuePmSync: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setDecisionMetadata: mocks.setDecisionMetadata,
	createFeatureVersion: mocks.createFeatureVersion,
	db: { userStory: { update: mocks.userStoryUpdate } },
	getStoryById: mocks.getStoryById,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../enqueue-pm-sync", () => ({ enqueuePmSync: mocks.enqueuePmSync }));

const { acceptPendingPatches, readPendingPatches } = await import(
	"../accept-pending-patches"
);

const DESCRIPTION = "# User Login\n\nUsers authenticate before the dashboard.";
const ACCEPTANCE =
	"- AC#1: The user logs in with email and password.\n- AC#2: The user is prompted for a TOTP code.";

const feature = {
	id: "story-1",
	projectId: "project-1",
	title: "Login",
	description: DESCRIPTION,
	acceptanceCriteria: ACCEPTANCE,
	summaryDigest: null,
	workingNotesContent: null,
	maturationV2OptedIn: true,
	cleanSpecApprovalMode: "MANUAL",
	decisionLogApprovalMode: null,
	summaryQuestionsApprovalMode: null,
} as never;

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

const PENDING = {
	from: "- AC#2: The user is prompted for a TOTP code.",
	to: "",
	summary: "Dropped the TOTP MFA requirement.",
};

function decisionWith(pendingPatches: unknown[]) {
	return {
		id: "dec-1",
		metadata: {
			cleanSpecPropagation: { status: "pending", pendingPatches },
		},
	} as never;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.setDecisionMetadata.mockResolvedValue(1);
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue(undefined);
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		version: 4,
		description: DESCRIPTION,
		acceptanceCriteria: ACCEPTANCE,
		draftingStage: "DRAFT",
		pmAutoSyncEnabled: true,
	});
	mocks.userStoryUpdate.mockResolvedValue({
		id: "story-1",
		pmAutoSyncEnabled: true,
	});
});

describe("acceptPendingPatches", () => {
	it("applies the pending patches, writes the spec, and clears the pending set", async () => {
		const out = await acceptPendingPatches({
			feature,
			decision: decisionWith([PENDING]),
			tenantFilter,
			projectId: "project-1",
		});

		expect(out.status).toBe("applied");
		expect(out.applied).toHaveLength(1);
		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		expect(
			mocks.userStoryUpdate.mock.calls[0][0].data.acceptanceCriteria,
		).toBe("- AC#1: The user logs in with email and password.");
		// Pending set cleared + status applied stamped on the decision.
		const meta = mocks.setDecisionMetadata.mock.calls.at(-1)?.[0].metadata;
		expect(meta.cleanSpecPropagation.status).toBe("applied");
		expect(meta.cleanSpecPropagation.pendingPatches).toEqual([]);
	});

	it("refuses (no write) when a stashed patch no longer locates", async () => {
		const out = await acceptPendingPatches({
			feature,
			decision: decisionWith([
				{
					from: "- AC#404: not in the spec",
					to: "x",
					summary: "stale",
				},
			]),
			tenantFilter,
			projectId: "project-1",
		});

		expect(out.status).toBe("refused");
		expect(out.failed.length).toBeGreaterThan(0);
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		const meta = mocks.setDecisionMetadata.mock.calls.at(-1)?.[0].metadata;
		expect(meta.cleanSpecPropagation.status).toBe("refused");
	});

	it("is a no-op when there are no pending patches", async () => {
		const out = await acceptPendingPatches({
			feature,
			decision: { id: "dec-1", metadata: null } as never,
			tenantFilter,
			projectId: "project-1",
		});
		expect(out.status).toBe("noop");
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.setDecisionMetadata).not.toHaveBeenCalled();
	});

	it("readPendingPatches ignores malformed metadata", () => {
		expect(readPendingPatches({ metadata: null } as never)).toEqual([]);
		expect(
			readPendingPatches({
				metadata: { cleanSpecPropagation: {} },
			} as never),
		).toEqual([]);
		expect(readPendingPatches(decisionWith([PENDING]))).toHaveLength(1);
	});
});
