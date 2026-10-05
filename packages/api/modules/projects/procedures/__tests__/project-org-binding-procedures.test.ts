/**
 * Project-scoped procedures run only in the authorized project's organization
 * (Fizzy #2904) — exercised end to end through the REAL procedure chain: the
 * root holder, the session middleware, `requireProjectPermission` and the
 * handler. Only I/O is mocked.
 *
 * The caller below can reach a project in ORG_PROJECT and names ORG_OTHER — the
 * shape of the defect: before the binding, the handler took ORG_OTHER verbatim
 * and ran retrieval, scans and lifecycle triggers on it.
 */
import { call } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_PROJECT = "org-example-project";
const ORG_OTHER = "org-example-other";
const PROJECT_ID = "project-example-1";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	retrieveProjectContexts: vi.fn(),
	startProjectScan: vi.fn(),
	assertCapabilityAvailable: vi.fn(),
	recordScanActivity: vi.fn(),
	deleteOpenProjectScanFindings: vi.fn(),
	dispatchLifecycleEvent: vi.fn(),
	createTask: vi.fn(),
	projectFindUnique: vi.fn(),
	createScanFindingGrouping: vi.fn(),
	createScanFindingReview: vi.fn(),
	workflowStart: vi.fn(),
	deleteStory: vi.fn(),
	storyFindFirst: vi.fn(),
	attachmentFindMany: vi.fn(),
	deleteFile: vi.fn(),
	recordAuditFromRequest: vi.fn(),
	toggleTaskComplete: vi.fn(),
}));

const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os } = await import("@orpc/server");
		return os.middleware(async ({ next }) => next());
	},
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	logDataEvent: vi.fn(async () => undefined),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mocks.projectFindUnique(...a),
		},
		userStory: {
			findFirst: (...a: unknown[]) => mocks.storyFindFirst(...a),
		},
		storyAttachment: {
			findMany: (...a: unknown[]) => mocks.attachmentFindMany(...a),
		},
	},
	deleteStory: (...a: unknown[]) => mocks.deleteStory(...a),
	toggleTaskComplete: (...a: unknown[]) => mocks.toggleTaskComplete(...a),
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: vi.fn(),
	grantProjectAccess: vi.fn(),
	StoryVersionConflictError: class extends Error {},
	hasProjectAccess: vi.fn(async () => true),
	getProjectScanConfig: vi.fn(async () => ({
		securityEnabled: true,
		accessibilityEnabled: false,
		semgrepEnabled: false,
		gitHistoryEnabled: false,
	})),
	failStaleProjectScans: vi.fn(async () => 0),
	hasActiveScan: vi.fn(async () => false),
	deleteOpenProjectScanFindings: (...a: unknown[]) =>
		mocks.deleteOpenProjectScanFindings(...a),
	recordScanActivity: (...a: unknown[]) => mocks.recordScanActivity(...a),
	getStoryById: vi.fn(async () => ({ id: "story-1" })),
	createTask: (...a: unknown[]) => mocks.createTask(...a),
	hasActiveScanFindingGrouping: vi.fn(async () => false),
	createScanFindingGrouping: (...a: unknown[]) =>
		mocks.createScanFindingGrouping(...a),
	updateScanFindingGrouping: vi.fn(async () => undefined),
	hasActiveScanReview: vi.fn(async () => false),
	createScanFindingReview: (...a: unknown[]) =>
		mocks.createScanFindingReview(...a),
	updateScanFindingReview: vi.fn(async () => undefined),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ deleteFile: mocks.deleteFile }),
}));
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) =>
		mocks.recordAuditFromRequest(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "query",
	contextMetaHeader: () => "",
	retrieveProjectContexts: (...a: unknown[]) =>
		mocks.retrieveProjectContexts(...a),
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
}));
vi.mock("../../../capabilities/assert", () => ({
	assertCapabilityAvailable: (...a: unknown[]) =>
		mocks.assertCapabilityAvailable(...a),
}));
vi.mock("../scan/lib/start-scan", () => ({
	startProjectScan: (...a: unknown[]) => mocks.startProjectScan(...a),
}));
vi.mock("../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: (...a: unknown[]) =>
		mocks.dispatchLifecycleEvent(...a),
}));
// Observability, audit and tenant-store middlewares each reach a database and
// are not under test; the permission middleware and resolvers are real.
vi.mock("../../../../orpc/middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-error-middleware", async () => ({
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../../../../orpc/middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));

import { getDocumentContextProcedure } from "../get-document-context";
import { startGroupingProcedure } from "../scan/start-grouping";
import { startReviewProcedure } from "../scan/start-review";
import { triggerScanProcedure } from "../scan/trigger-scan";
import { deleteStoryProcedure } from "../stories/delete-story";
import { createTaskProcedure } from "../stories/tasks/create-task";
import { toggleTaskProcedure } from "../stories/tasks/toggle-task";

const context = { headers: new Headers() };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: ORG_OTHER },
		user: { id: USER_ID },
	});
	// The caller reaches the project through an organization role.
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "org",
		organizationId: ORG_PROJECT,
		permissions: [
			Permissions.PROJECT_READ,
			Permissions.PROJECT_UPDATE,
			Permissions.STORY_CREATE,
			Permissions.STORY_UPDATE,
			Permissions.STORY_DELETE,
		],
		organizationDeleted: false,
	});
	mocks.retrieveProjectContexts.mockResolvedValue([]);
	mocks.startProjectScan.mockResolvedValue({
		scanId: "scan-1",
		workflowId: "wf-1",
	});
	mocks.createTask.mockResolvedValue({ id: "task-1" });
	mocks.dispatchLifecycleEvent.mockResolvedValue({ matched: 0, started: 0 });
	mocks.recordScanActivity.mockResolvedValue(undefined);
	mocks.deleteOpenProjectScanFindings.mockResolvedValue(0);
	mocks.createScanFindingGrouping.mockResolvedValue({ id: "grouping-1" });
	mocks.createScanFindingReview.mockResolvedValue({ id: "review-1" });
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mocks.storyFindFirst.mockResolvedValue({ title: "Example story" });
	mocks.attachmentFindMany.mockResolvedValue([
		{ storageKey: "story-attachments/example/file.pdf" },
	]);
	mocks.deleteStory.mockResolvedValue(undefined);
	mocks.deleteFile.mockResolvedValue(undefined);
	mocks.toggleTaskComplete.mockResolvedValue({
		id: "task-1",
		title: "Example task",
		isCompleted: true,
	});
});

/** The caller is the owner of a legacy project that has no organization. */
function projectWithoutOrganization() {
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "owner",
		organizationId: null,
		permissions: [],
		organizationDeleted: false,
	});
}

describe("an AI-reaching procedure (document context retrieval)", () => {
	const input = { projectId: PROJECT_ID, documentType: "PRD" };

	it("refuses another organization before any retrieval or provider runs", async () => {
		await expect(
			call(
				getDocumentContextProcedure,
				{ ...input, organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
		expect(mocks.retrieveProjectContexts).not.toHaveBeenCalled();
	});

	it("retrieves in the project's organization when none is named, not the session's", async () => {
		await call(
			getDocumentContextProcedure,
			{ ...input, organizationId: null },
			{ context },
		);
		expect(mocks.retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
	});
});

describe("the scan starter", () => {
	it("refuses another organization before any scan row, activity or workflow", async () => {
		await expect(
			call(
				triggerScanProcedure,
				{
					projectId: PROJECT_ID,
					organizationId: ORG_OTHER,
					purgeUnresolved: true,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.deleteOpenProjectScanFindings).not.toHaveBeenCalled();
		expect(mocks.recordScanActivity).not.toHaveBeenCalled();
		expect(mocks.assertCapabilityAvailable).not.toHaveBeenCalled();
		expect(mocks.startProjectScan).not.toHaveBeenCalled();
	});

	it("stamps and starts the scan in the project's organization", async () => {
		await call(
			triggerScanProcedure,
			{
				projectId: PROJECT_ID,
				organizationId: null,
				purgeUnresolved: true,
			},
			{ context },
		);
		expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
		expect(mocks.recordScanActivity).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
		expect(mocks.startProjectScan).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
		// The binding answered; the project row was not re-read.
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});
});

describe("the grouping and review starters", () => {
	it.each([
		[
			"grouping",
			() => startGroupingProcedure,
			mocks.createScanFindingGrouping,
		],
		["review", () => startReviewProcedure, mocks.createScanFindingReview],
	] as const)(
		"%s: refuses another organization before any row or workflow",
		async (_label, procedure, create) => {
			await expect(
				call(
					procedure(),
					{
						projectId: PROJECT_ID,
						organizationId: ORG_OTHER,
						scanId: "scan-1",
					},
					{ context },
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(create).not.toHaveBeenCalled();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"grouping",
			() => startGroupingProcedure,
			mocks.createScanFindingGrouping,
		],
		["review", () => startReviewProcedure, mocks.createScanFindingReview],
	] as const)(
		"%s: stamps the row and starts the workflow in the project's organization",
		async (_label, procedure, create) => {
			await call(
				procedure(),
				{
					projectId: PROJECT_ID,
					organizationId: null,
					scanId: "scan-1",
				},
				{ context },
			);
			expect(create).toHaveBeenCalledWith(
				expect.objectContaining({ organizationId: ORG_PROJECT }),
			);
			const options = mocks.workflowStart.mock.calls[0]?.[1] as {
				args: Array<{ organizationId?: string }>;
			};
			expect(options.args[0]?.organizationId).toBe(ORG_PROJECT);
		},
	);
});

describe("task creation's lifecycle dispatch", () => {
	const input = {
		projectId: PROJECT_ID,
		storyId: "story-1",
		title: "Example task",
	};

	it("refuses another organization before the task is written or any trigger fires", async () => {
		await expect(
			call(
				createTaskProcedure,
				{ ...input, organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.createTask).not.toHaveBeenCalled();
		expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
	});

	it("selects triggers in the project's organization", async () => {
		await call(createTaskProcedure, { ...input }, { context });
		expect(mocks.dispatchLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
	});
});

// Fizzy #2904 review: both handlers used to write first and resolve the
// organization after, so a refusal arrived with the delete or toggle already
// committed (and, for the toggle, rewritten into "Task not found").
describe("story deletion refuses before it deletes", () => {
	const input = { projectId: PROJECT_ID, storyId: "story-1" };

	it("refuses another organization with nothing deleted and no audit row", async () => {
		await expect(
			call(
				deleteStoryProcedure,
				{ ...input, organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
		expect(mocks.deleteStory).not.toHaveBeenCalled();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses a project with no organization with nothing deleted", async () => {
		projectWithoutOrganization();
		await expect(
			call(deleteStoryProcedure, { ...input }, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteStory).not.toHaveBeenCalled();
		expect(mocks.deleteFile).not.toHaveBeenCalled();
	});

	it("deletes and audits in the project's organization", async () => {
		await expect(
			call(
				deleteStoryProcedure,
				{ ...input, organizationId: null },
				{ context },
			),
		).resolves.toEqual({ success: true });
		expect(mocks.deleteStory).toHaveBeenCalledWith("story-1", PROJECT_ID);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "story.deleted",
				organizationId: ORG_PROJECT,
			}),
		);
	});
});

describe("task toggling refuses before it toggles", () => {
	const input = {
		projectId: PROJECT_ID,
		storyId: "story-1",
		taskId: "task-1",
	};

	it("refuses another organization with the task untouched, as BAD_REQUEST not NOT_FOUND", async () => {
		await expect(
			call(
				toggleTaskProcedure,
				{ ...input, organizationId: ORG_OTHER },
				{ context },
			),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.toggleTaskComplete).not.toHaveBeenCalled();
		expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
	});

	it("refuses a project with no organization with the task untouched, as FORBIDDEN not NOT_FOUND", async () => {
		projectWithoutOrganization();
		await expect(
			call(toggleTaskProcedure, { ...input }, { context }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.toggleTaskComplete).not.toHaveBeenCalled();
	});

	it("toggles and dispatches in the project's organization", async () => {
		await call(toggleTaskProcedure, { ...input }, { context });
		expect(mocks.toggleTaskComplete).toHaveBeenCalledWith("task-1");
		expect(mocks.dispatchLifecycleEvent).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_PROJECT }),
		);
	});

	it("still answers NOT_FOUND for a missing task", async () => {
		mocks.toggleTaskComplete.mockRejectedValue(new Error("not found"));
		await expect(
			call(toggleTaskProcedure, { ...input }, { context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
