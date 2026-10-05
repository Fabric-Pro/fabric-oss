/**
 * The project wizard's temp-context procedures through the REAL procedure
 * chain (Fizzy #2904 review).
 *
 * The pre-project procedures check the caller's role in the organization the
 * input names. With `organizationId: null` nothing resolved and that check
 * passed straight through, so an organization VIEWER — whom the session-role
 * check used to refuse — could upload and process temp contexts, then move
 * them into a project where they can only view (the move checked visibility
 * alone). Now the pre-project procedures require an organization, and the
 * move needs permission to add context to the destination project.
 */
import { call } from "@orpc/server";
import {
	ORG_ROLE_PERMISSIONS,
	PROJECT_ROLE_PERMISSIONS,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_A = "org-example-alpha";
const PROJECT_ID = "project-example-1";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getOrganizationMembership: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	createWizardTempContext: vi.fn(),
	getWizardTempContextById: vi.fn(),
	moveWizardTempContextsToProject: vi.fn(),
	workflowStart: vi.fn(),
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
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ supportsPresignedUrls: false }),
}));
vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentTypeSchema: { options: ["PRD", "SPEC"] },
}));
vi.mock("@repo/database", () => ({
	db: {},
	StoryVersionConflictError: class extends Error {},
	getTenantContext: () => ({ effectiveWriteOrgId: null }),
	getOrganizationMembership: (...a: unknown[]) =>
		mocks.getOrganizationMembership(...a),
	grantProjectAccess: vi.fn(),
	createWizardTempContext: (...a: unknown[]) =>
		mocks.createWizardTempContext(...a),
	getWizardTempContextById: (...a: unknown[]) =>
		mocks.getWizardTempContextById(...a),
	moveWizardTempContextsToProject: (...a: unknown[]) =>
		mocks.moveWizardTempContextsToProject(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: {},
}));
// Observability, audit and tenant-store middlewares each reach a database and
// are not under test; the permission middlewares and resolvers are real.
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

import { createTempUploadUrlProcedure } from "../create-temp-upload-url";
import { moveToProjectProcedure } from "../move-to-project";
import { processTempFileProcedure } from "../process-temp-file";

const context = { headers: new Headers() };

/** An organization VIEWER of ORG_A, with ORG_A active. */
function viewerOfOrganization() {
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: ORG_A },
		user: { id: USER_ID },
	});
	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string) =>
			organizationId === ORG_A
				? {
						role: "viewer",
						organization: { id: ORG_A, deletedAt: null },
					}
				: null,
	);
}

/** The caller's access to the destination project, by real project role. */
function projectRole(role: keyof typeof PROJECT_ROLE_PERMISSIONS) {
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source: "project-member",
		organizationId: ORG_A,
		permissions: [...PROJECT_ROLE_PERMISSIONS[role]],
		organizationDeleted: false,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	viewerOfOrganization();
	mocks.createWizardTempContext.mockResolvedValue({ id: "temp-1" });
	mocks.getWizardTempContextById.mockResolvedValue({
		id: "temp-1",
		sessionId: "session-1",
		extractionStatus: "PENDING",
		embeddedAt: null,
	});
	mocks.moveWizardTempContextsToProject.mockResolvedValue({
		movedCount: 1,
		contextIds: ["context-1"],
		contextIdMapping: { "temp-1": "context-1" },
		sessionId: "session-1",
	});
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
});

describe("an organization viewer sending a null organization", () => {
	it("holds no permission the wizard's writes need, by the real role table", () => {
		// The premise: the refusals below are role refusals, not fixtures.
		expect(ORG_ROLE_PERMISSIONS.viewer).not.toContain("project:create");
		expect(ORG_ROLE_PERMISSIONS.viewer).not.toContain("project:update");
	});

	it("cannot get an upload URL, and no temp context is created", async () => {
		await expect(
			call(
				createTempUploadUrlProcedure,
				{
					sessionId: "session-1",
					organizationId: null,
					filename: "notes.md",
					mimeType: "text/markdown",
					size: 10,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createWizardTempContext).not.toHaveBeenCalled();
	});

	it("cannot process a temp context, and no workflow starts", async () => {
		await expect(
			call(
				processTempFileProcedure,
				{ contextId: "temp-1", organizationId: null },
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getWizardTempContextById).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("cannot move temp contexts into a project they only view", async () => {
		projectRole("VIEWER");
		await expect(
			call(
				moveToProjectProcedure,
				{
					sessionId: "session-1",
					projectId: PROJECT_ID,
					organizationId: null,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.moveWizardTempContextsToProject).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});
});

describe("an organization viewer naming their organization", () => {
	it("is still refused the upload by role", async () => {
		await expect(
			call(
				createTempUploadUrlProcedure,
				{
					sessionId: "session-1",
					organizationId: ORG_A,
					filename: "notes.md",
					mimeType: "text/markdown",
					size: 10,
				},
				{ context },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createWizardTempContext).not.toHaveBeenCalled();
	});
});

describe("moving temp contexts into a project", () => {
	it("is refused to a project VIEWER whatever organization is named", async () => {
		projectRole("VIEWER");
		for (const organizationId of [ORG_A, undefined]) {
			await expect(
				call(
					moveToProjectProcedure,
					{
						sessionId: "session-1",
						projectId: PROJECT_ID,
						organizationId,
					},
					{ context },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.moveWizardTempContextsToProject).not.toHaveBeenCalled();
	});

	it("is allowed to a project EDITOR, in the project's organization even when none is named", async () => {
		projectRole("EDITOR");
		await call(
			moveToProjectProcedure,
			{
				sessionId: "session-1",
				projectId: PROJECT_ID,
				organizationId: null,
			},
			{ context },
		);
		expect(mocks.moveWizardTempContextsToProject).toHaveBeenCalledWith(
			"session-1",
			PROJECT_ID,
			USER_ID,
			ORG_A,
		);
		const options = mocks.workflowStart.mock.calls[0]?.[1] as {
			args: Array<{ organizationId?: string }>;
		};
		expect(options.args[0]?.organizationId).toBe(ORG_A);
	});
});

describe("a member who can upload", () => {
	it("stamps the temp context with the session's organization when none is named", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({
			role: "member",
			organization: { id: ORG_A, deletedAt: null },
		});
		await call(
			createTempUploadUrlProcedure,
			{
				sessionId: "session-1",
				filename: "notes.md",
				mimeType: "text/markdown",
				size: 10,
			},
			{ context },
		);
		expect(mocks.createWizardTempContext).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: ORG_A }),
		);
	});
});
