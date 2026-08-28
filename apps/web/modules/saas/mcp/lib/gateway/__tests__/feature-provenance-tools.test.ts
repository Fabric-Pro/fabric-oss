/**
 * `fabric_get_feature_decisions` / `fabric_get_feature_versions` tests, plus the
 * `pmSync` block `fabric_get_feature` grew alongside them.
 *
 * These three answer "why does the spec say this, how did it get here, and does
 * the linked PM card still reflect it" — so the cases below pin the promises
 * that make those answers trustworthy: decision content is passed through
 * verbatim rather than summarised, an all-AI decision log is distinguishable
 * from one a person actually settled, the version list stays cheap by omitting
 * bodies that run to tens of KB, and a personal-context session sends a
 * `organizationId: null` tenant filter rather than an org one.
 *
 * `@repo/database` is mocked — the handlers reach it through dynamic
 * `await import(...)`, so the mock intercepts inside the handler body. The
 * tenant filter is asserted on the *arguments* the query received, because a
 * mocked query returns the right rows no matter what filter it was handed.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/feature-provenance-tools
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getStoryById: vi.fn(),
	listDecisionLogThreads: vi.fn(),
	getFeatureVersions: vi.fn(),
	getFeatureVersion: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getStoryById: mocks.getStoryById,
	listDecisionLogThreads: mocks.listDecisionLogThreads,
	getFeatureVersions: mocks.getFeatureVersions,
	getFeatureVersion: mocks.getFeatureVersion,
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const personalSession: GatewaySession = { ...session, organizationId: null };

/** Parse the JSON payload a platform tool packs into its text content block. */
function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

function storyRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: "F-042",
		title: "Inbox view",
		description: "spec body",
		acceptanceCriteria: "1. GIVEN ... THEN ...",
		statusId: "status-inprogress",
		status: {
			id: "status-inprogress",
			name: "In Progress",
			color: "#000",
			isFinal: false,
		},
		priority: "P2_MEDIUM",
		size: null,
		storyPoints: null,
		draftingStage: "PUBLISHED",
		maturationStatus: "DISCOVERY",
		assigneeId: null,
		externalId: "1234",
		externalUrl: "https://pm.example/cards/1234",
		pmAutoSyncEnabled: false,
		lastSyncedStatusId: "status-backlog",
		tasks: [],
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-20T00:00:00Z"),
		...overrides,
	};
}

/** A question root a person asked and answered. */
function humanThread() {
	return {
		root: {
			id: "dec-1",
			status: "RESOLVED",
			topic: "Read/unread scope",
			impactedSection: "Requirements",
			summary: "Per-user or shared?",
			content: "Is read state per user or shared across contributors?",
			authorType: "USER",
			authorName: "Example PM",
			source: "HUMAN",
			decidedBy: "Example PM",
			sourceProvenance: null,
			createdAt: new Date("2026-08-10T00:00:00Z"),
		},
		replies: [
			{
				id: "dec-1-r1",
				content:
					"Per user. Shared state would leak one reviewer onto another.",
				summary: null,
				authorType: "USER",
				authorName: "Example PM",
				source: "HUMAN",
				answerSource: "MANUAL",
				decidedBy: "Example PM",
				createdAt: new Date("2026-08-11T00:00:00Z"),
			},
		],
	};
}

/** A question the AI raised, answered and marked settled on its own. */
function aiThread() {
	return {
		root: {
			id: "dec-2",
			status: "OPEN",
			topic: "Snooze storage",
			impactedSection: "Data",
			summary: "New column or new table?",
			content:
				"Should snoozeUntil live on the topic row or its own table?",
			authorType: "AGENT",
			authorName: "Fabric AI",
			source: "AI_CONFIRMED",
			decidedBy: null,
			sourceProvenance: "maturation-run-7",
			createdAt: new Date("2026-08-12T00:00:00Z"),
		},
		replies: [],
	};
}

function versionRow(version: number, overrides: Record<string, unknown> = {}) {
	return {
		version,
		storyId: "story-1",
		createdAt: new Date("2026-08-15T00:00:00Z"),
		draftingStage: "PUBLISHED",
		changedBy: "Example PM",
		changeDescription: `run ${version}`,
		changeSummary: [`Requirements: tightened FR${version}`],
		// Bodies the list must NOT return — a mature spec carries tens of KB here.
		description: "x".repeat(20_000),
		acceptanceCriteria: "y".repeat(5_000),
		summaryDigestSnapshot: "digest",
		workingNotesSnapshot: "notes",
		userId: "user-1",
		organizationId: "org-1",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getStoryById.mockResolvedValue(storyRow());
	mocks.listDecisionLogThreads.mockResolvedValue([humanThread(), aiThread()]);
	mocks.getFeatureVersions.mockResolvedValue({
		versions: [versionRow(2), versionRow(1)],
		total: 2,
		hasMore: false,
	});
	mocks.getFeatureVersion.mockResolvedValue(versionRow(1));
});

describe("declarations", () => {
	it.each(["fabric_get_feature_decisions", "fabric_get_feature_versions"])(
		"declares %s as a read-only platform tool",
		(name) => {
			const definition = PLATFORM_TOOL_DEFINITIONS.find(
				(tool) => tool.name === name,
			);
			expect(definition).toBeDefined();
			expect(definition?.annotations?.readOnlyHint).toBe(true);
			expect(definition?._gateway_source).toBe("platform");
			expect(definition?.inputSchema.required).toEqual([
				"featureId",
				"projectId",
			]);
		},
	);
});

describe("fabric_get_feature_decisions", () => {
	it("returns decision content verbatim, never summarised", async () => {
		const result = await executePlatformTool(
			"fabric_get_feature_decisions",
			{ featureId: "story-1", projectId: "proj-1" },
			session,
		);

		const body = payload(result);
		expect(body.threads[0].content).toBe(
			"Is read state per user or shared across contributors?",
		);
		expect(body.threads[0].replies[0].content).toBe(
			"Per user. Shared state would leak one reviewer onto another.",
		);
	});

	it("distinguishes a human-settled log from an all-AI one", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_decisions",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.totalThreads).toBe(2);
		expect(body.humanAuthoredThreads).toBe(1);
		expect(body.openThreads).toBe(1);
		expect(body.threads[1].source).toBe("AI_CONFIRMED");
		expect(body.threads[0].replies[0].answerSource).toBe("MANUAL");
	});

	it("keeps the counts over the whole log when a status filter narrows the list", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_decisions",
				{ featureId: "story-1", projectId: "proj-1", status: "OPEN" },
				session,
			),
		);

		expect(body.threads).toHaveLength(1);
		expect(body.threads[0].status).toBe("OPEN");
		expect(body.totalThreads).toBe(2);
	});

	it("sends an org tenant filter in organization context", async () => {
		await executePlatformTool(
			"fabric_get_feature_decisions",
			{ featureId: "story-1", projectId: "proj-1" },
			session,
		);

		expect(mocks.listDecisionLogThreads).toHaveBeenCalledWith({
			tenantFilter: { organizationId: "org-1", userId: "user-1" },
			userStoryId: "story-1",
		});
	});

	it("sends a null-organization tenant filter in personal context", async () => {
		await executePlatformTool(
			"fabric_get_feature_decisions",
			{ featureId: "story-1", projectId: "proj-1" },
			personalSession,
		);

		expect(mocks.listDecisionLogThreads).toHaveBeenCalledWith({
			tenantFilter: { organizationId: null, userId: "user-1" },
			userStoryId: "story-1",
		});
	});

	it("reports an empty log rather than failing when maturation never ran", async () => {
		mocks.listDecisionLogThreads.mockResolvedValue([]);

		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_decisions",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.threads).toEqual([]);
		expect(body.totalThreads).toBe(0);
	});

	it("never queries the log when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_get_feature_decisions",
			{ featureId: "story-1", projectId: "proj-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/not found or access denied/i);
		expect(mocks.listDecisionLogThreads).not.toHaveBeenCalled();
	});

	it("rejects a feature that does not belong to the project", async () => {
		mocks.getStoryById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_get_feature_decisions",
			{ featureId: "story-other", projectId: "proj-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/feature not found/i);
		expect(mocks.listDecisionLogThreads).not.toHaveBeenCalled();
	});
});

describe("fabric_get_feature_versions", () => {
	it("omits version bodies from the list", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_versions",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.versions).toHaveLength(2);
		expect(body.versions[0]).not.toHaveProperty("description");
		expect(body.versions[0]).not.toHaveProperty("acceptanceCriteria");
		expect(body.versions[0]).not.toHaveProperty("summaryDigestSnapshot");
		expect(body.versions[0].changeSummary).toEqual([
			"Requirements: tightened FR2",
		]);
	});

	it("returns one revision in full when a version is named", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_versions",
				{ featureId: "story-1", projectId: "proj-1", version: 1 },
				session,
			),
		);

		expect(mocks.getFeatureVersion).toHaveBeenCalledWith("story-1", 1);
		expect(body.version.version).toBe(1);
		expect(body.version.description).toHaveLength(20_000);
		expect(body.version.workingNotesSnapshot).toBe("notes");
		expect(mocks.getFeatureVersions).not.toHaveBeenCalled();
	});

	it("clamps the page size to 50", async () => {
		await executePlatformTool(
			"fabric_get_feature_versions",
			{ featureId: "story-1", projectId: "proj-1", limit: 500 },
			session,
		);

		expect(mocks.getFeatureVersions).toHaveBeenCalledWith("story-1", 50, 0);
	});

	it("errors on a version that does not exist", async () => {
		mocks.getFeatureVersion.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_get_feature_versions",
			{ featureId: "story-1", projectId: "proj-1", version: 99 },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toMatch(/version 99 not found/i);
	});

	it("reports an empty history rather than failing", async () => {
		mocks.getFeatureVersions.mockResolvedValue({
			versions: [],
			total: 0,
			hasMore: false,
		});

		const body = payload(
			await executePlatformTool(
				"fabric_get_feature_versions",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.versions).toEqual([]);
		expect(body.total).toBe(0);
	});
});

describe("fabric_get_feature pmSync", () => {
	it("flags a status that has drifted since the last push", async () => {
		const body = payload(
			await executePlatformTool(
				"fabric_get_feature",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.pmSync).toEqual({
			autoSyncEnabled: false,
			lastSyncedStatusId: "status-backlog",
			statusDrifted: true,
		});
		expect(body.maturationStatus).toBe("DISCOVERY");
	});

	it("does not report drift when the last push matches the current status", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ lastSyncedStatusId: "status-inprogress" }),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_feature",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.pmSync.statusDrifted).toBe(false);
	});

	it("does not report drift for a feature that was never pushed", async () => {
		mocks.getStoryById.mockResolvedValue(
			storyRow({ lastSyncedStatusId: null, externalId: null }),
		);

		const body = payload(
			await executePlatformTool(
				"fabric_get_feature",
				{ featureId: "story-1", projectId: "proj-1" },
				session,
			),
		);

		expect(body.pmSync.statusDrifted).toBe(false);
	});
});
