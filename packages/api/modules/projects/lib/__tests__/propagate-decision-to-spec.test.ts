import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TG4 — Decision → Clean-Spec propagation. The model and the DB
 * writes are mocked; the REAL patch application (`applySpecPatches`), combine/
 * split, and effective-approval-mode logic run so these tests assert the actual
 * branching the procedure relies on:
 *
 *   AUTO_ACCEPT → write + version + (cloud-gated) PM sync
 *   MANUAL      → persist PENDING, NO write
 *   refused     → any unlocated patch ⇒ whole set refused, NO write
 *   noop        → model returns no patches
 *   skipped     → feature not opted into v2 ⇒ no model call at all
 */

const mocks = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	generateObject: vi.fn(),
	getStoryById: vi.fn(),
	createFeatureVersion: vi.fn(),
	userStoryUpdate: vi.fn(),
	getApprovalPreference: vi.fn(),
	enqueuePmSync: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	generateObject: mocks.generateObject,
}));

// Real effective-mode logic (feature override → user pref → hard default).
const HARD_DEFAULT_APPROVAL_MODE = {
	cleanSpec: "AUTO_ACCEPT",
	decisionLog: "AUTO_ACCEPT",
	summaryQuestions: "MANUAL",
} as const;
type Tab = "cleanSpec" | "decisionLog" | "summaryQuestions";
const FEATURE_FIELD: Record<Tab, string> = {
	cleanSpec: "cleanSpecApprovalMode",
	decisionLog: "decisionLogApprovalMode",
	summaryQuestions: "summaryQuestionsApprovalMode",
};
const USER_FIELD: Record<Tab, string> = {
	cleanSpec: "cleanSpecMode",
	decisionLog: "decisionLogMode",
	summaryQuestions: "summaryQuestionsMode",
};
function effectiveApprovalMode(
	feature: Record<string, unknown> | null,
	userPref: Record<string, unknown> | null,
	tab: Tab,
) {
	const featureMode = feature ? feature[FEATURE_FIELD[tab]] : null;
	if (featureMode != null) {
		return featureMode;
	}
	const userMode = userPref ? userPref[USER_FIELD[tab]] : null;
	if (userMode != null) {
		return userMode;
	}
	return HARD_DEFAULT_APPROVAL_MODE[tab];
}

vi.mock("@repo/database", () => ({
	createFeatureVersion: mocks.createFeatureVersion,
	db: { userStory: { update: mocks.userStoryUpdate } },
	effectiveApprovalMode,
	getApprovalPreference: mocks.getApprovalPreference,
	getStoryById: mocks.getStoryById,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../enqueue-pm-sync", () => ({ enqueuePmSync: mocks.enqueuePmSync }));

const { propagateDecisionToCleanSpec } = await import(
	"../propagate-decision-to-spec"
);

const DESCRIPTION = "# User Login\n\nUsers authenticate before the dashboard.";
const ACCEPTANCE =
	"- AC#1: The user logs in with email and password.\n- AC#2: The user is prompted for a TOTP code.";

function makeFeature(overrides: Record<string, unknown> = {}) {
	return {
		id: "story-1",
		projectId: "project-1",
		title: "Login",
		description: DESCRIPTION,
		acceptanceCriteria: ACCEPTANCE,
		summaryDigest: null,
		workingNotesContent: null,
		maturationV2OptedIn: true,
		cleanSpecApprovalMode: null,
		decisionLogApprovalMode: null,
		summaryQuestionsApprovalMode: null,
		...overrides,
	} as never;
}

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

function mockModelPatches(patches: unknown[]) {
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { providerKey: "stub" },
	});
	mocks.generateObject.mockResolvedValue({ object: { patches } });
}

// Deletes AC#2 — a single, verbatim-locatable patch.
const DELETE_AC2 = {
	from: "- AC#2: The user is prompted for a TOTP code.",
	to: "",
	summary: "Dropped the TOTP MFA requirement.",
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.getApprovalPreference.mockResolvedValue(null);
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue(undefined);
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		version: 3,
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

describe("propagateDecisionToCleanSpec — AUTO_ACCEPT", () => {
	it("appends the locked-attachment rule to the spec-patch prompt", async () => {
		mockModelPatches([]);
		await propagateDecisionToCleanSpec({
			feature: makeFeature(),
			projectId: "project-1",
			tenantFilter,
			decisionText: "Defer MFA",
		});
		const prompt = mocks.generateObject.mock.calls[0][0].prompt as string;
		expect(prompt).toContain("DEDICATED ATTACHMENTS");
	});

	it("applies the patch, snapshots versions, writes the split spec, and PM-syncs", async () => {
		mockModelPatches([DELETE_AC2]);

		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature(),
			projectId: "project-1",
			tenantFilter,
			decisionText: "Defer MFA",
		});

		expect(out.status).toBe("applied");
		expect(out.applied).toHaveLength(1);
		expect(out.pmSyncEnqueued).toBe(true);

		// Two version snapshots (before = v3, after = v4).
		expect(mocks.createFeatureVersion).toHaveBeenCalledTimes(2);

		// The write persisted the patched split: AC#2 gone, description untouched.
		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		const writeArg = mocks.userStoryUpdate.mock.calls[0][0];
		expect(writeArg.where).toEqual({
			id: "story-1",
			projectId: "project-1",
		});
		expect(writeArg.data.version).toBe(4);
		expect(writeArg.data.description).toBe(DESCRIPTION);
		expect(writeArg.data.acceptanceCriteria).toBe(
			"- AC#1: The user logs in with email and password.",
		);
		// draftingStage is NOT touched (in-stage edit, not a transition).
		expect(writeArg.data.draftingStage).toBeUndefined();

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
	});

	it("does NOT PM-sync when the feature's cloud toggle is off", async () => {
		mockModelPatches([DELETE_AC2]);
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-1",
			pmAutoSyncEnabled: false,
		});

		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature(),
			projectId: "project-1",
			tenantFilter,
			decisionText: "Defer MFA",
		});

		expect(out.status).toBe("applied");
		expect(out.pmSyncEnqueued).toBe(false);
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});
});

describe("propagateDecisionToCleanSpec — MANUAL", () => {
	it("holds patches as PENDING and does not write the spec or PM-sync", async () => {
		mockModelPatches([DELETE_AC2]);

		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature({ cleanSpecApprovalMode: "MANUAL" }),
			projectId: "project-1",
			tenantFilter,
			decisionText: "Defer MFA",
		});

		expect(out.status).toBe("pending");
		expect(out.pending).toHaveLength(1);
		expect(out.applied).toHaveLength(0);
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.createFeatureVersion).not.toHaveBeenCalled();
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});
});

describe("propagateDecisionToCleanSpec — refusal & no-op", () => {
	it("refuses the whole set when any patch can't be located verbatim", async () => {
		mockModelPatches([
			DELETE_AC2,
			{ from: "- AC#404: not in the spec", to: "x", summary: "bogus" },
		]);

		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature(),
			projectId: "project-1",
			tenantFilter,
			decisionText: "Two edits, one bogus",
		});

		expect(out.status).toBe("refused");
		expect(out.failed.length).toBeGreaterThan(0);
		expect(out.applied).toHaveLength(0);
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("is a no-op when the model returns no patches", async () => {
		mockModelPatches([]);

		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature(),
			projectId: "project-1",
			tenantFilter,
			decisionText: "No spec impact",
		});

		expect(out.status).toBe("noop");
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	});
});

describe("propagateDecisionToCleanSpec — gating", () => {
	it("skips entirely (no model call) when the feature is not opted into v2", async () => {
		const out = await propagateDecisionToCleanSpec({
			feature: makeFeature({ maturationV2OptedIn: false }),
			projectId: "project-1",
			tenantFilter,
			decisionText: "anything",
		});

		expect(out.status).toBe("skipped");
		expect(mocks.getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(mocks.generateObject).not.toHaveBeenCalled();
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
	});
});
