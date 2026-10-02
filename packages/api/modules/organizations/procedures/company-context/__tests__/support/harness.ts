/**
 * Shared test double for the company context procedures (Fizzy #2719).
 *
 * The permission middleware under test is the REAL `requireInputOrgPermission`
 * and the REAL `assertProjectPermission`, evaluated against the organization
 * in the input and against mocked membership rows — so a FORBIDDEN or a
 * NOT_FOUND in these tests is the gate's own answer, as in the Brand kit's
 * tests. Everything outside the API package (database, Temporal, storage,
 * RAG) is mocked.
 *
 * Each test file wires the mocks with `vi.mock(<module>, () => import(...))`
 * factories that read from here. This module imports nothing that is mocked,
 * so a factory can load it at any point.
 */
import { vi } from "vitest";

export const ORG = "org_a";
export const OTHER_ORG = "org_b";
export const PROJECT = "proj_a";
export const OTHER_PROJECT = "proj_b";

/** The current embedding model of every organization, unless a test says otherwise. */
export const CURRENT_MODEL = {
	identity: "openai:text-embedding-3-small",
	dimensions: 1536,
	supported: true,
};

export class FakeAIProviderNotConfiguredError extends Error {
	constructor(message = "No embedding provider configured") {
		super(message);
		this.name = "AIProviderNotConfiguredError";
	}
}

/** Temporal's answer to creating a schedule whose id already exists. */
export class FakeScheduleAlreadyRunning extends Error {
	constructor(message = "Schedule already exists and is running") {
		super(message);
		this.name = "ScheduleAlreadyRunning";
	}
}

/** Temporal's answer to describing a schedule it does not know. */
export class FakeScheduleNotFoundError extends Error {
	constructor(message = "Schedule not found") {
		super(message);
		this.name = "ScheduleNotFoundError";
	}
}

/**
 * Temporal's answer to cancelling a workflow that already closed: a
 * `WorkflowNotFoundError` whose message is the server's.
 */
export class FakeWorkflowNotFoundError extends Error {
	constructor(message = "workflow execution already completed") {
		super(message);
		this.name = "WorkflowNotFoundError";
	}
}

export const mocks = {
	getOrganizationMembership: vi.fn(),
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
	grantProjectAccess: vi.fn(),
	listCompanyContextSources: vi.fn(),
	getCompanyContextSource: vi.fn(),
	getCompanyContextSourceMeta: vi.fn(),
	listReadyCompanyContextSourceIds: vi.fn(),
	getCompanyContextReadiness: vi.fn(),
	createCompanyFileSource: vi.fn(),
	createCompanyTextSource: vi.fn(),
	createCompanyLinkSource: vi.fn(),
	updateCompanyContextSourceStatus: vi.fn(),
	updateCompanyLinkSourceCrawlState: vi.fn(),
	updateCompanyContextSourceMetadata: vi.fn(),
	claimCompanyLinkSourceCrawl: vi.fn(),
	claimCompanyContextSourceForReprocess: vi.fn(),
	claimCompanyFileSourceForProcessing: vi.fn(),
	releaseCompanyContextSourceClaim: vi.fn(),
	getEnabledOrganizationSearchProviders: vi.fn(),
	sourceCount: vi.fn(),
	sourceUpdateMany: vi.fn(),
	urlPageFindMany: vi.fn(),
	urlPageCount: vi.fn(),
	projectFindUnique: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
	organizationFindUnique: vi.fn(),
	recordAudit: vi.fn(),
	workflowStart: vi.fn(),
	workflowGetHandle: vi.fn(),
	workflowCancel: vi.fn(),
	createUrlSourceSchedule: vi.fn(),
	deleteUrlSourceSchedule: vi.fn(),
	scheduleGetHandle: vi.fn(),
	scheduleDescribe: vi.fn(),
	resolveCompanyEmbeddingModel: vi.fn(),
	getSignedUploadUrl: vi.fn(),
	getSignedUrl: vi.fn(),
	uploadFile: vi.fn(),
	decryptApiKey: vi.fn(),
};

// ---------------------------------------------------------------------------
// Module factories
// ---------------------------------------------------------------------------

export function databaseModule() {
	return {
		db: {
			companyContextSource: {
				count: mocks.sourceCount,
				updateMany: mocks.sourceUpdateMany,
			},
			companyContextUrlPage: {
				findMany: mocks.urlPageFindMany,
				count: mocks.urlPageCount,
			},
			project: { findUnique: mocks.projectFindUnique },
			projectMember: { findUnique: mocks.projectMemberFindUnique },
			member: { findFirst: mocks.memberFindFirst },
			organization: { findUnique: mocks.organizationFindUnique },
		},
		getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
		getOrganizationMembership: mocks.getOrganizationMembership,
		isFeatureEnabled: mocks.isFeatureEnabled,
		resolveProjectTenant: mocks.resolveProjectTenant,
		grantProjectAccess: mocks.grantProjectAccess,
		listCompanyContextSources: mocks.listCompanyContextSources,
		getCompanyContextSource: mocks.getCompanyContextSource,
		getCompanyContextSourceMeta: mocks.getCompanyContextSourceMeta,
		listReadyCompanyContextSourceIds:
			mocks.listReadyCompanyContextSourceIds,
		getCompanyContextReadiness: mocks.getCompanyContextReadiness,
		createCompanyFileSource: mocks.createCompanyFileSource,
		createCompanyTextSource: mocks.createCompanyTextSource,
		createCompanyLinkSource: mocks.createCompanyLinkSource,
		updateCompanyContextSourceStatus:
			mocks.updateCompanyContextSourceStatus,
		updateCompanyLinkSourceCrawlState:
			mocks.updateCompanyLinkSourceCrawlState,
		updateCompanyContextSourceMetadata:
			mocks.updateCompanyContextSourceMetadata,
		claimCompanyLinkSourceCrawl: mocks.claimCompanyLinkSourceCrawl,
		claimCompanyContextSourceForReprocess:
			mocks.claimCompanyContextSourceForReprocess,
		claimCompanyFileSourceForProcessing:
			mocks.claimCompanyFileSourceForProcessing,
		releaseCompanyContextSourceClaim:
			mocks.releaseCompanyContextSourceClaim,
		getEnabledOrganizationSearchProviders:
			mocks.getEnabledOrganizationSearchProviders,
		companyContextStoragePrefix: (organizationId: string) =>
			`${organizationId}/company-context/`,
		normalizeContextMetadataValue: (value: string | null | undefined) =>
			value?.trim() ? value.trim() : null,
		// Imported by the project procedures this module reuses constants from;
		// never reached by a company procedure.
		createLinkContext: vi.fn(),
		getEnabledUserSearchProviders: vi.fn(),
		hasProjectAccess: vi.fn(),
		updateContextExtractionStatus: vi.fn(),
		updateContextMetadata: vi.fn(),
	};
}

export function temporalModule() {
	const workflow = {
		start: mocks.workflowStart,
		getHandle: mocks.workflowGetHandle,
	};
	return {
		COMPANY_CONTEXT_TASK_QUEUE: "company-context",
		contextOwnerTaskQueue: (
			owner: { kind: string } | null | undefined,
			projectQueue: string,
		) => (owner?.kind === "company" ? "company-context" : projectQueue),
		getTemporalClient: vi.fn(async () => ({ workflow })),
		getScheduleClient: vi.fn(async () => ({
			getHandle: mocks.scheduleGetHandle,
		})),
		buildUrlSourceScheduleId: (contextId: string) =>
			`url-source-schedule-${contextId}`,
		createUrlSourceSchedule: mocks.createUrlSourceSchedule,
		deleteUrlSourceSchedule: mocks.deleteUrlSourceSchedule,
		ScheduleAlreadyRunning: FakeScheduleAlreadyRunning,
		ScheduleNotFoundError: FakeScheduleNotFoundError,
		isScheduledMode: (mode: string | null | undefined) =>
			mode === "DAILY" || mode === "WEEKLY" || mode === "MONTHLY",
		cadenceNextFireUtc: (mode: string | null | undefined) =>
			mode === "DAILY" ? new Date("2026-10-01T00:00:00Z") : null,
	};
}

export function ragModule() {
	return {
		resolveCompanyEmbeddingModel: mocks.resolveCompanyEmbeddingModel,
		UNSUPPORTED_EMBEDDING_MODEL_REASON: "Unsupported embedding model",
		unsupportedEmbeddingModelMessage: (model: { identity: string }) =>
			`Unsupported embedding model: ${model.identity}`,
	};
}

export function aiModule() {
	return { AIProviderNotConfiguredError: FakeAIProviderNotConfiguredError };
}

export function storageModule() {
	return {
		getStorageProvider: () => ({
			type: "s3",
			supportsPresignedUrls: true,
			getSignedUploadUrl: mocks.getSignedUploadUrl,
		}),
		getSignedUrl: mocks.getSignedUrl,
		uploadFile: mocks.uploadFile,
	};
}

export async function utilsModule(importOriginal: () => Promise<unknown>) {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, decryptApiKey: mocks.decryptApiKey };
}

export function logsModule() {
	return {
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
	};
}

export function configModule() {
	return {
		config: {
			storage: { bucketNames: { projectContexts: "contexts-bucket" } },
		},
	};
}

export function auditModule() {
	return { recordAuditFromRequest: mocks.recordAudit };
}

/**
 * The procedure builder, recording the ONE permission middleware and the
 * input schema each procedure declares. State resets after every `.handler`,
 * so a procedure that declares no middleware (the notice state) cannot
 * inherit the previous one's.
 */
export async function proceduresModule() {
	const { Permissions } =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const middleware = await vi.importActual<
		typeof import("../../../../../../orpc/middleware/require-permission")
	>("../../../../../../orpc/middleware/require-permission");
	let state: { middleware?: unknown; input?: unknown } = {};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: unknown) => {
			state.middleware = mw;
			return chain;
		},
		route: () => chain,
		input: (schema: unknown) => {
			state.input = schema;
			return chain;
		},
		output: () => chain,
		handler: (fn: unknown) => {
			const wired = {
				__handler: fn,
				__middleware: state.middleware,
				__input: state.input,
			};
			state = {};
			return wired;
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions,
		requireInputOrgPermission: middleware.requireInputOrgPermission,
		assertProjectPermission: middleware.assertProjectPermission,
		requireProjectPermission: () => () => undefined,
		requirePermission: () => () => undefined,
		resolveOrganizationId: (value: string | null | undefined) =>
			value ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// People and calling
// ---------------------------------------------------------------------------

/** Role of each user in each organization. */
export const roles = new Map<string, string>();

/** Accepted project memberships: `${projectId}:${userId}` → project role. */
export const projectMembers = new Map<string, string>();

export const PROJECTS: Record<string, { organizationId: string }> = {
	[PROJECT]: { organizationId: ORG },
	[OTHER_PROJECT]: { organizationId: OTHER_ORG },
};

/**
 * Seed the organizations: an owner, an admin, a member and a viewer of A; an
 * admin of B; a guest of A's project with no member row in A; and a platform
 * administrator who belongs to neither.
 */
export function seedPeople(): void {
	roles.clear();
	projectMembers.clear();
	roles.set(`${ORG}:u_owner`, "owner");
	roles.set(`${ORG}:u_admin`, "admin");
	roles.set(`${ORG}:u_member`, "member");
	roles.set(`${ORG}:u_viewer`, "viewer");
	roles.set(`${OTHER_ORG}:u_b_admin`, "admin");
	projectMembers.set(`${PROJECT}:u_guest`, "EDITOR");

	mocks.getOrganizationMembership.mockImplementation(
		async (organizationId: string, userId: string) => {
			const role = roles.get(`${organizationId}:${userId}`);
			return role ? { role, organization: { id: organizationId } } : null;
		},
	);
	mocks.memberFindFirst.mockImplementation(
		async ({
			where,
		}: {
			where: { organizationId: string; userId: string };
		}) => {
			const role = roles.get(`${where.organizationId}:${where.userId}`);
			return role ? { role } : null;
		},
	);
	mocks.projectFindUnique.mockImplementation(
		async ({ where }: { where: { id: string } }) => {
			const project = PROJECTS[where.id];
			return project
				? {
						id: where.id,
						organizationId: project.organizationId,
						userId: "u_creator",
					}
				: null;
		},
	);
	mocks.projectMemberFindUnique.mockImplementation(
		async ({
			where,
		}: {
			where: { projectId_userId: { projectId: string; userId: string } };
		}) => {
			const { projectId, userId } = where.projectId_userId;
			const role = projectMembers.get(`${projectId}:${userId}`);
			return role
				? { role, acceptedAt: new Date("2026-01-01"), expiresAt: null }
				: null;
		},
	);
	mocks.resolveProjectTenant.mockImplementation(async (projectId: string) => {
		const project = PROJECTS[projectId];
		return project
			? { organizationId: project.organizationId, userId: null }
			: null;
	});
}

export function context(userId: string) {
	const home = userId === "u_b_admin" ? OTHER_ORG : ORG;
	return {
		headers: new Headers(),
		user: {
			id: userId,
			name: userId,
			email: `${userId}@example.com`,
			role: userId === "u_platform" ? "admin" : "user",
		},
		session: { id: `session-${userId}`, activeOrganizationId: home },
		tenantContext: { userId, type: "organization", organizationId: home },
	};
}

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
	}) => Promise<Record<string, unknown>>;
	__middleware?: (
		args: { context: unknown; next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;
	__input: {
		parse: (value: unknown) => Record<string, unknown>;
		safeParse: (value: unknown) => { success: boolean };
	};
};

export function inputSchemaOf(procedure: unknown): Wired["__input"] {
	return (procedure as Wired).__input;
}

/** Input validation, the real permission middleware, then the handler. */
export async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string,
): Promise<any> {
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
	const ctx = context(userId);
	if (!wired.__middleware) {
		return wired.__handler({ input, context: ctx });
	}
	let output: Record<string, unknown> | undefined;
	await wired.__middleware(
		{
			context: ctx,
			next: async () => {
				output = await wired.__handler({ input, context: ctx });
				return { output };
			},
		},
		input,
	);
	return output;
}

/** The ORPC code a call rejects with. */
export async function rejection(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("expected a rejection");
}

/** A stored company source, with overrides. */
export function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "src_1",
		organizationId: ORG,
		type: "TEXT",
		content: "We built a warehouse management system for a logistics firm.",
		metadata: {},
		qdrantId: null,
		embeddedAt: new Date("2026-09-01"),
		embeddingModel: CURRENT_MODEL.identity,
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		fileSize: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		extractedAt: new Date("2026-09-01"),
		deletingAt: null as Date | null,
		sourceUrl: null,
		sourceTitle: "Case study",
		urlScope: null,
		urlMaxPages: null,
		urlRefreshMode: null,
		urlNextRefreshAt: null,
		urlLastSyncedAt: null,
		urlScheduleId: null,
		urlActiveWorkflowId: null,
		sourceType: null,
		aiInstructions: null,
		metadataUpdatedAt: null,
		metadataUpdatedByUserId: null,
		contentHash: "a".repeat(64),
		createdByUserId: "u_admin",
		createdAt: new Date("2026-09-01"),
		updatedAt: new Date("2026-09-01"),
		...overrides,
	};
}

/** A listed company source (no content, with its page count). */
export function listRow(overrides: Record<string, unknown> = {}) {
	const { content: _content, ...row } = sourceRow(overrides);
	return { ...row, _count: { urlPages: 0 } };
}

/**
 * Point the by-id source lookups at `rows`, keyed by organization so another
 * organization's id reads as missing. The metadata lookup answers the row
 * without its content, as the query's `omit` does.
 */
export function storeSources(rows: ReturnType<typeof sourceRow>[]): void {
	const find = (id: string, organizationId: string) =>
		rows.find(
			(row) => row.id === id && row.organizationId === organizationId,
		) ?? null;
	mocks.getCompanyContextSource.mockImplementation(
		async (id: string, organizationId: string) => find(id, organizationId),
	);
	mocks.getCompanyContextSourceMeta.mockImplementation(
		async (id: string, organizationId: string) => {
			const row = find(id, organizationId);
			if (!row) {
				return null;
			}
			const { content: _content, ...meta } = row;
			return meta;
		},
	);
	mocks.listCompanyContextSources.mockImplementation(
		async (organizationId: string) =>
			rows
				.filter((row) => row.organizationId === organizationId)
				.map((row) => {
					const { content: _content, ...listed } = row;
					return { ...listed, _count: { urlPages: 0 } };
				}),
	);
}

/** Defaults every test starts from: gate on, one current model, happy writes. */
export function resetDefaults(): void {
	vi.clearAllMocks();
	seedPeople();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue(CURRENT_MODEL);
	mocks.listReadyCompanyContextSourceIds.mockResolvedValue([]);
	mocks.getCompanyContextReadiness.mockResolvedValue({ total: 0, ready: 0 });
	mocks.sourceCount.mockResolvedValue(0);
	mocks.sourceUpdateMany.mockResolvedValue({ count: 1 });
	storeSources([]);
	mocks.updateCompanyContextSourceStatus.mockResolvedValue(true);
	mocks.updateCompanyLinkSourceCrawlState.mockResolvedValue(true);
	mocks.claimCompanyLinkSourceCrawl.mockResolvedValue(true);
	mocks.claimCompanyContextSourceForReprocess.mockResolvedValue(true);
	mocks.claimCompanyFileSourceForProcessing.mockResolvedValue(true);
	mocks.releaseCompanyContextSourceClaim.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.workflowGetHandle.mockImplementation(() => ({
		cancel: mocks.workflowCancel,
	}));
	mocks.workflowCancel.mockResolvedValue(undefined);
	mocks.createUrlSourceSchedule.mockImplementation(
		async (args: { contextId: string }) => ({
			scheduleId: `url-source-schedule-${args.contextId}`,
		}),
	);
	mocks.deleteUrlSourceSchedule.mockResolvedValue(undefined);
	mocks.scheduleGetHandle.mockImplementation(() => ({
		describe: mocks.scheduleDescribe,
	}));
	mocks.scheduleDescribe.mockResolvedValue({});
	mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
		{
			providerName: "firecrawl",
			encryptedApiKey: "encrypted",
			enabled: true,
			isDefault: true,
			priority: 0,
			createdAt: new Date("2026-01-01"),
		},
	]);
	mocks.decryptApiKey.mockReturnValue("fc-test-key");
	mocks.getSignedUploadUrl.mockResolvedValue(
		"https://storage.example.com/put",
	);
	mocks.getSignedUrl.mockResolvedValue("https://storage.example.com/get");
	mocks.uploadFile.mockResolvedValue(undefined);
	mocks.urlPageFindMany.mockResolvedValue([]);
	mocks.urlPageCount.mockResolvedValue(0);
	mocks.organizationFindUnique.mockResolvedValue({ slug: "example-org" });
	let created = 0;
	const createdRow =
		(type: string) => async (input: Record<string, unknown>) => {
			created += 1;
			return sourceRow({
				id: `src_new_${created}`,
				type,
				extractionStatus: "PENDING",
				embeddedAt: null,
				embeddingModel: null,
				...input,
			});
		};
	mocks.createCompanyTextSource.mockImplementation(createdRow("TEXT"));
	mocks.createCompanyFileSource.mockImplementation(createdRow("FILE"));
	mocks.createCompanyLinkSource.mockImplementation(createdRow("LINK"));
}
