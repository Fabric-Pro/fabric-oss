/**
 * Shared world for the Glossy procedure tests (Fizzy #2589, U11).
 *
 * Two organizations, two projects, and one user per access path:
 *
 *  - `owner`       — org A owner, creator of project A;
 *  - `editor`      — org A member with an EDITOR row on project A;
 *  - `guestViewer` — a VIEWER row on project A, no org A membership (AE7);
 *  - `guestEditor` — an EDITOR row on project A, no org A membership;
 *  - `outsider`    — org B owner, creator of project B.
 *
 * The permission decision is the real one: `assertProjectPermission` and the
 * shared Glossy gate run against this world through a fake `db`. The Glossy
 * queries, Temporal, the model, storage, and the audit writer are mocks the
 * tests drive. `planGlossyKeys` and `resolveGlossyModel` are the real ones —
 * the latter over a fake `getAIModelWithMetadata` that honours an
 * organization key or the requesting editor's personal key (KTD21).
 * `extractGlossyVisual` is the real one too, behind a spy, over a mocked
 * `generateObject`: a regenerate runs the real spec validation and label
 * guard against what the "model" returned (U20).
 *
 * `useEditionStore` backs the edition queries with one in-memory edition
 * that applies the same guards as the real queries, for tests that chain
 * procedures (review, then regenerate, then read).
 *
 * Each test file wires this in with its own `vi.mock` calls (they must live
 * in the test file to be hoisted); the factories import this module lazily,
 * so it never statically imports a module the tests mock.
 */

import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { vi } from "vitest";

export const ORG_A = "org-a";
const ORG_B = "org-b";
export const PROJECT_A = "proj-a";
export const PROJECT_B = "proj-b";
export const DOC_A = "doc-a";
export const DOC_B = "doc-b";
export const DOC_PRD = "doc-prd";

export const USERS = {
	owner: "user-owner",
	editor: "user-editor",
	guestViewer: "user-guest-viewer",
	guestEditor: "user-guest-editor",
	outsider: "user-outsider",
} as const;

/** A Proposal with three main-flow sections and no scaffolding. */
export const PROPOSAL_BODY = [
	"# Example Proposal",
	"",
	"## Executive Summary",
	"",
	"We propose a pilot for Example Org costing $240k, starting Q3 2026.",
	"",
	"## Approach",
	"",
	"First we discover. Then we build and measure.",
	"",
	"## Team",
	"",
	"Alex leads delivery. Sam owns design.",
].join("\n");

interface WorldDocument {
	id: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	type: string;
	status: string;
	title: string;
	content: string;
	version: number;
}

interface World {
	projects: Map<
		string,
		{
			organizationId: string | null;
			userId: string;
			deletedAt: Date | null;
		}
	>;
	documents: Map<string, WorldDocument>;
	/** `${organizationId}:${userId}` → org role. */
	orgMembers: Map<string, string>;
	/** `${projectId}:${userId}` → project role (accepted, not expiring). */
	projectMembers: Map<string, string>;
	users: Map<string, string>;
	organizations: Map<
		string,
		{ name: string; logo: string | null; brandColor: string | null }
	>;
	/** The GLOSSY_EDITION rollout gate, per organization. */
	flags: Map<string, boolean>;
	brandKits: Map<string, { accentColors: string[]; guidance: string | null }>;
	recipientBrands: Map<
		string,
		{
			version: number;
			name: string | null;
			website: string | null;
			colors: string[];
			logoKey: string | null;
			updatedAt: Date;
		}
	>;
	linkSources: Array<{
		projectId: string;
		sourceUrl: string | null;
		knowledgeBaseSourceCategory: string | null;
	}>;
	/** Organizations with a configured AI provider. */
	orgProviderKeys: Set<string>;
	/** Users with a personal AI provider key. */
	personalProviderKeys: Set<string>;
	/** Stored objects by `${bucket}/${key}`; none unless a test puts one. */
	storedObjects: Map<string, { data: Buffer; contentType: string }>;
}

function createWorld(): World {
	const document = (
		id: string,
		projectId: string,
		organizationId: string,
		overrides: Partial<WorldDocument> = {},
	): [string, WorldDocument] => [
		id,
		{
			id,
			projectId,
			organizationId,
			userId: null,
			type: "PROPOSAL",
			status: "COMPLETE",
			title: "Example Proposal",
			content: PROPOSAL_BODY,
			version: 5,
			...overrides,
		},
	];
	return {
		projects: new Map([
			[
				PROJECT_A,
				{ organizationId: ORG_A, userId: USERS.owner, deletedAt: null },
			],
			[
				PROJECT_B,
				{
					organizationId: ORG_B,
					userId: USERS.outsider,
					deletedAt: null,
				},
			],
		]),
		documents: new Map([
			document(DOC_A, PROJECT_A, ORG_A),
			document(DOC_B, PROJECT_B, ORG_B),
			document(DOC_PRD, PROJECT_A, ORG_A, {
				type: "PRD",
				title: "Example PRD",
			}),
		]),
		orgMembers: new Map([
			[`${ORG_A}:${USERS.owner}`, "owner"],
			[`${ORG_A}:${USERS.editor}`, "member"],
			[`${ORG_B}:${USERS.outsider}`, "owner"],
		]),
		projectMembers: new Map([
			[`${PROJECT_A}:${USERS.editor}`, "EDITOR"],
			[`${PROJECT_A}:${USERS.guestViewer}`, "VIEWER"],
			[`${PROJECT_A}:${USERS.guestEditor}`, "EDITOR"],
		]),
		users: new Map([
			[USERS.owner, "Olivia Owner"],
			[USERS.editor, "Eddie Editor"],
			[USERS.guestViewer, "Gina Guest"],
			[USERS.guestEditor, "Gus Guest"],
			[USERS.outsider, "Otto Outsider"],
		]),
		organizations: new Map([
			[
				ORG_A,
				{
					name: "Example Org",
					// The key the organization logo upload writes.
					logo: "org-a.png",
					brandColor: "ocean",
				},
			],
			[ORG_B, { name: "Other Org", logo: null, brandColor: null }],
		]),
		flags: new Map([
			[ORG_A, true],
			[ORG_B, true],
		]),
		brandKits: new Map([
			[
				ORG_A,
				{ accentColors: ["#123456"], guidance: "Calm and precise." },
			],
			[ORG_B, { accentColors: ["#654321"], guidance: "Other guidance." }],
		]),
		recipientBrands: new Map(),
		linkSources: [],
		orgProviderKeys: new Set([ORG_A, ORG_B]),
		personalProviderKeys: new Set(),
		storedObjects: new Map(),
	};
}

export const world: World = createWorld();

export function resetWorld(): void {
	Object.assign(world, createWorld());
}

// ---------------------------------------------------------------------------
// Mocks the tests drive
// ---------------------------------------------------------------------------

export const mocks = {
	getGlossyEdition: vi.fn(),
	claimGlossyBuild: vi.fn(),
	releaseGlossyClaim: vi.fn(),
	getCacheEntries: vi.fn(),
	putCacheEntry: vi.fn(),
	getGlossyBuildSnapshot: vi.fn(),
	applyVisualRegeneration: vi.fn(),
	upsertVisualDecision: vi.fn(),
	clearVisualDecision: vi.fn(),
	recordAudit: vi.fn(),
	workflowStart: vi.fn(),
	describe: vi.fn(),
	getTemporalClient: vi.fn(),
	detect: vi.fn(),
	/** A spy over the real `extractGlossyVisual`, unless a test replaces it. */
	extract: vi.fn(),
	generateObject: vi.fn(),
	getAIModel: vi.fn(),
	enforceAiRateLimit: vi.fn(),
	getSignedUrl: vi.fn(),
	getFileMetadata: vi.fn(),
	downloadFile: vi.fn(),
};

/** The real `extractGlossyVisual`, captured when `@repo/temporal` is mocked. */
let realExtract: ((input: never) => Promise<unknown>) | null = null;

/** Reset every mock to the healthy default. */
export function resetMocks(): void {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.getGlossyEdition.mockResolvedValue(null);
	mocks.releaseGlossyClaim.mockResolvedValue("applied");
	mocks.getCacheEntries.mockResolvedValue(new Map());
	mocks.putCacheEntry.mockResolvedValue("applied");
	mocks.workflowStart.mockResolvedValue({ workflowId: "wf" });
	mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });
	mocks.getTemporalClient.mockImplementation(async () => ({
		workflow: {
			start: mocks.workflowStart,
			getHandle: (workflowId: string) => ({
				describe: () => mocks.describe(workflowId),
			}),
		},
	}));
	mocks.enforceAiRateLimit.mockResolvedValue(undefined);
	mocks.getAIModel.mockImplementation(fakeResolver);
	mocks.extract.mockImplementation(async (input: never) => {
		if (!realExtract) {
			throw new Error(
				"@repo/temporal is not mocked through temporalModule",
			);
		}
		return realExtract(input);
	});
	mocks.getSignedUrl.mockImplementation(
		async (key: string, options: { bucket: string }) =>
			`https://storage.example.com/${options.bucket}/${key}?signed`,
	);
	// Like the S3 provider: a missing object is `null` metadata, and a
	// download of one throws.
	mocks.getFileMetadata.mockImplementation(
		async (key: string, options: { bucket: string }) => {
			const object = world.storedObjects.get(`${options.bucket}/${key}`);
			return object
				? {
						size: object.data.length,
						contentType: object.contentType,
						uploadedAt: new Date("2026-09-01"),
						pathname: key,
						url: `https://storage.example.com/${options.bucket}/${key}`,
					}
				: null;
		},
	);
	mocks.downloadFile.mockImplementation(
		async (key: string, options: { bucket: string }) => {
			const object = world.storedObjects.get(`${options.bucket}/${key}`);
			if (!object) {
				throw new Error("Could not download file from S3: NoSuchKey");
			}
			return {
				data: Buffer.from(object.data),
				contentType: object.contentType,
				size: object.data.length,
			};
		},
	);
}

// ---------------------------------------------------------------------------
// Module factories (called from each test file's vi.mock)
// ---------------------------------------------------------------------------

function projectMemberRole(projectId: string, userId: string) {
	return world.projectMembers.get(`${projectId}:${userId}`);
}

function orgMemberRole(organizationId: string | null, userId: string) {
	return organizationId
		? world.orgMembers.get(`${organizationId}:${userId}`)
		: undefined;
}

const fakeDb = {
	project: {
		findUnique: async ({ where }: { where: { id: string } }) => {
			const project = world.projects.get(where.id);
			return project ? { id: where.id, ...project } : null;
		},
	},
	projectMember: {
		findUnique: async ({
			where,
		}: {
			where: { projectId_userId: { projectId: string; userId: string } };
		}) => {
			const role = projectMemberRole(
				where.projectId_userId.projectId,
				where.projectId_userId.userId,
			);
			return role
				? { role, acceptedAt: new Date("2026-09-01"), expiresAt: null }
				: null;
		},
	},
	member: {
		findFirst: async ({
			where,
		}: {
			where: { organizationId: string; userId: string };
		}) => {
			const role = orgMemberRole(where.organizationId, where.userId);
			return role ? { role } : null;
		},
	},
	organization: {
		findUnique: async ({ where }: { where: { id: string } }) => {
			const organization = world.organizations.get(where.id);
			return organization
				? { name: organization.name, logo: organization.logo }
				: null;
		},
	},
	user: {
		findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
			where.id.in.flatMap((id) => {
				const name = world.users.get(id);
				return name === undefined ? [] : [{ id, name }];
			}),
	},
	projectContext: {
		findMany: async ({ where }: { where: { projectId: string } }) =>
			world.linkSources
				.filter(
					(source) =>
						source.projectId === where.projectId &&
						source.sourceUrl,
				)
				.map(({ sourceUrl, knowledgeBaseSourceCategory }) => ({
					sourceUrl,
					knowledgeBaseSourceCategory,
				})),
	},
};

export async function databaseModule() {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: fakeDb,
		grantProjectAccess: vi.fn(),
		adoptDocumentIntoProjectTenant: vi.fn(),
		isFeatureEnabled: async (flag: string, organizationId?: string) =>
			flag === "GLOSSY_EDITION" &&
			Boolean(organizationId) &&
			(world.flags.get(organizationId as string) ?? false),
		resolveProjectTenant: async (projectId: string) => {
			const project = world.projects.get(projectId);
			return project
				? { organizationId: project.organizationId, userId: null }
				: null;
		},
		getDocumentById: async (documentId: string) => {
			const document = world.documents.get(documentId);
			if (!document) {
				return null;
			}
			const project = world.projects.get(document.projectId);
			return {
				...document,
				project: {
					id: document.projectId,
					name: "Example Project",
					userId: project?.userId ?? null,
					organizationId: project?.organizationId ?? null,
				},
				versions: [],
				currentContentHash: actual.computeDocumentContentHash(
					document.content,
				),
			};
		},
		// The real rule: an org member needs ownership or a project row; an
		// invited guest needs the project row.
		hasProjectAccess: async (projectId: string, userId: string) => {
			const project = world.projects.get(projectId);
			if (!project) {
				return false;
			}
			const member = projectMemberRole(projectId, userId);
			if (orgMemberRole(project.organizationId, userId)) {
				return project.userId === userId || Boolean(member);
			}
			return Boolean(member);
		},
		// PROJECT_UPDATE by the same precedence the middleware uses.
		canEditProject: async (projectId: string, userId: string) => {
			const project = world.projects.get(projectId);
			if (!project) {
				return false;
			}
			const member = projectMemberRole(projectId, userId);
			const granted = member
				? resolveProjectPermissions(member)
				: resolveOrgPermissions(
						orgMemberRole(project.organizationId, userId),
					);
			return hasPermission(granted, Permissions.PROJECT_UPDATE);
		},
		getGlossyEdition: mocks.getGlossyEdition,
		claimGlossyBuild: mocks.claimGlossyBuild,
		releaseGlossyClaim: mocks.releaseGlossyClaim,
		getCacheEntries: mocks.getCacheEntries,
		putCacheEntry: mocks.putCacheEntry,
		getGlossyBuildSnapshot: mocks.getGlossyBuildSnapshot,
		applyVisualRegeneration: mocks.applyVisualRegeneration,
		upsertVisualDecision: mocks.upsertVisualDecision,
		clearVisualDecision: mocks.clearVisualDecision,
		getBrandKitForProject: async (projectId: string) => {
			const organizationId =
				world.projects.get(projectId)?.organizationId;
			const kit = organizationId
				? world.brandKits.get(organizationId)
				: undefined;
			return kit && organizationId
				? {
						organizationId,
						...kit,
						updatedById: null,
						updatedAt: new Date("2026-09-01"),
					}
				: null;
		},
		getRecipientBrand: async (projectId: string) =>
			world.recipientBrands.get(projectId) ?? null,
		getOrganizationBrandColor: async (organizationId: string) =>
			world.organizations.get(organizationId)?.brandColor ?? null,
	};
}

export async function temporalModule() {
	const actual =
		await vi.importActual<typeof import("@repo/temporal")>(
			"@repo/temporal",
		);
	realExtract = actual.extractGlossyVisual as typeof realExtract;
	return {
		...actual,
		getTemporalClient: mocks.getTemporalClient,
		detectGlossyOpportunities: mocks.detect,
		extractGlossyVisual: mocks.extract,
	};
}

/** The resolver's own error class, so `resolveGlossyModel` recognizes it. */
let ProviderNotConfigured: new (message: string) => Error = Error;

/** An organization key, or the requesting editor's personal key (KTD21). */
async function fakeResolver(
	_options: unknown,
	context: { userId?: string; organizationId?: string },
) {
	if (
		(context.organizationId &&
			world.orgProviderKeys.has(context.organizationId)) ||
		(context.userId && world.personalProviderKeys.has(context.userId))
	) {
		return {
			model: {},
			modelId: "example-model",
			provider: "example",
			metadata: { provider: "OPENAI" },
			trackUsage: () => {},
		};
	}
	throw new ProviderNotConfigured("No AI provider is configured");
}

export async function aiModule() {
	const actual = await vi.importActual<typeof import("@repo/ai")>("@repo/ai");
	ProviderNotConfigured = actual.AIProviderNotConfiguredError;
	return {
		...actual,
		getAIModelWithMetadata: mocks.getAIModel,
		generateObject: mocks.generateObject,
	};
}

export async function storageModule() {
	const actual =
		await vi.importActual<typeof import("@repo/storage")>("@repo/storage");
	return {
		...actual,
		getStorageProvider: () => ({
			getSignedUrl: mocks.getSignedUrl,
			getFileMetadata: mocks.getFileMetadata,
			downloadFile: mocks.downloadFile,
		}),
	};
}

/** A stand-in for the oRPC builder that records what each procedure declares. */
export async function proceduresModule() {
	const state: { permission?: string; input?: unknown; output?: unknown } =
		{};
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: (mw: { __permission?: string }) => {
			state.permission = mw.__permission;
			return chain;
		},
		route: () => chain,
		input: (schema: unknown) => {
			state.input = schema;
			return chain;
		},
		output: (schema: unknown) => {
			state.output = schema;
			return chain;
		},
		handler: (fn: unknown) => ({
			__handler: fn,
			__permission: state.permission,
			__input: state.input,
			__output: state.output,
		}),
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (permission: string) => ({
			__permission: permission,
		}),
		enforceAiRateLimit: mocks.enforceAiRateLimit,
		Permissions,
	};
}

// ---------------------------------------------------------------------------
// Calling a procedure
// ---------------------------------------------------------------------------

type Schema = {
	parse: (value: unknown) => Record<string, unknown>;
};

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
		path: string[];
		signal?: AbortSignal;
	}) => Promise<Record<string, unknown>>;
	__permission: string;
	__input: Schema;
	__output: Schema;
};

type AssertProjectPermission = (
	projectId: string,
	userId: string,
	permission: never,
) => Promise<void>;

let assertProjectPermission: AssertProjectPermission | null = null;

/**
 * The real middleware decision, handed in by each test file from its own
 * static import: a module this harness imported itself could resolve
 * `@repo/database` past the test file's mock.
 */
export function usePermissionCheck(check: AssertProjectPermission): void {
	assertProjectPermission = check;
}

/**
 * Run a procedure as `userId`: its input schema, the real project
 * permission middleware decision, the handler, then its output schema — so
 * a result the wire would reject fails the test.
 */
export async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string = USERS.editor,
): Promise<Record<string, unknown>> {
	if (!assertProjectPermission) {
		throw new Error(
			"Call usePermissionCheck(assertProjectPermission) first",
		);
	}
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput);
	await assertProjectPermission(
		input.projectId as string,
		userId,
		wired.__permission as never,
	);
	const result = await wired.__handler({
		input,
		context: {
			user: {
				id: userId,
				name: world.users.get(userId) ?? "Someone",
				email: `${userId}@example.com`,
			},
			// A guest's session names their own organization, never the host's.
			session: { id: "session-1", activeOrganizationId: "org-own" },
		},
		path: ["projects", "glossy", "procedure"],
	});
	return wired.__output.parse(result);
}

/** Resolves to the thrown oRPC error's code, or fails when nothing was thrown. */
export async function errorCode(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
	throw new Error("Expected the call to throw");
}

// ---------------------------------------------------------------------------
// Edition fixtures
// ---------------------------------------------------------------------------

export function buildSummary(overrides: Record<string, unknown> = {}) {
	return {
		id: "build-1",
		status: "SUCCEEDED",
		startedById: USERS.editor,
		startedAt: new Date("2026-09-24T10:00:00.000Z"),
		heartbeatAt: new Date("2026-09-24T10:05:00.000Z"),
		finishedAt: new Date("2026-09-24T10:05:00.000Z"),
		workflowId: `glossy-edition-build-${DOC_A}-build-1`,
		progressStep: "finalizing",
		sectionsDone: 3,
		sectionsTotal: 3,
		errorCode: null,
		errorMessage: null,
		sourceTitle: "Example Proposal",
		sourceVersion: 5,
		sourceContentHash: "0000000000000000",
		...overrides,
	};
}

export function editionView(overrides: Record<string, unknown> = {}) {
	return {
		id: "edition-1",
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		content: null,
		contentRevision: 1,
		publishedBuildId: null,
		currentBuildId: null,
		lastOptions: null,
		updatedAt: new Date("2026-09-24T10:05:00.000Z"),
		decisions: [],
		publishedBuild: null,
		currentBuild: null,
		latestAttempt: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// One in-memory edition (U20)
// ---------------------------------------------------------------------------

export interface StoredDecision {
	visualKey: string;
	sectionKey: string;
	decision: "ACCEPTED" | "DISCARDED";
	specHash: string | null;
	decidedById: string | null;
	updatedAt: Date;
}

export interface EditionStore {
	/** The published `EditionContent`, as stored. */
	content: unknown;
	contentRevision: number;
	publishedBuildId: string | null;
	/** The claim: set while a build runs. */
	currentBuildId: string | null;
	/** Attempt summaries by id, for the published build and the claim holder. */
	builds: Map<string, ReturnType<typeof buildSummary>>;
	decisions: Map<string, StoredDecision>;
	/** EXTRACTION cache rows by cache key. */
	extractionCache: Map<
		string,
		{ sectionKey: string | null; output: unknown }
	>;
	/** Attempt snapshots by build id, as `getGlossyBuildSnapshot` returns them. */
	snapshots: Map<string, unknown>;
}

const DECIDED_AT = new Date("2026-09-24T11:00:00.000Z");

/**
 * Back the edition queries with one edition of `DOC_A` in `PROJECT_A`,
 * applying the guards of the real queries:
 *  - `applyVisualRegeneration` writes only while the published attempt and
 *    the content revision are the ones the caller read and no build holds
 *    the claim; then content, the cache row, and the cleared acceptance
 *    change together, and otherwise nothing does;
 *  - `upsertVisualDecision` and `clearVisualDecision` write the decision.
 * Reads hand out copies, as a database would.
 */
export function useEditionStore(
	initial: Partial<EditionStore> = {},
): EditionStore {
	const store: EditionStore = {
		content: null,
		contentRevision: 1,
		publishedBuildId: null,
		currentBuildId: null,
		builds: new Map(),
		decisions: new Map(),
		extractionCache: new Map(),
		snapshots: new Map(),
		...initial,
	};
	const isEdition = (documentId: string, projectId: string) =>
		documentId === DOC_A && projectId === PROJECT_A;

	mocks.getGlossyEdition.mockImplementation(
		async (input: { documentId: string; projectId: string }) => {
			if (!isEdition(input.documentId, input.projectId)) {
				return null;
			}
			const summary = (id: string | null) =>
				id ? structuredClone(store.builds.get(id) ?? null) : null;
			return editionView({
				content: structuredClone(store.content),
				contentRevision: store.contentRevision,
				publishedBuildId: store.publishedBuildId,
				currentBuildId: store.currentBuildId,
				decisions: [...store.decisions.values()].map((decision) => ({
					...decision,
				})),
				publishedBuild: summary(store.publishedBuildId),
				currentBuild: summary(store.currentBuildId),
			});
		},
	);
	mocks.getGlossyBuildSnapshot.mockImplementation(async (buildId: string) =>
		structuredClone(store.snapshots.get(buildId) ?? null),
	);
	mocks.applyVisualRegeneration.mockImplementation(
		async (input: {
			documentId: string;
			projectId: string;
			expectedPublishedBuildId: string;
			expectedContentRevision: number;
			content: unknown;
			visualKey: string;
			cacheEntry: {
				cacheKey: string;
				sectionKey: string | null;
				output: unknown;
			};
		}) => {
			if (
				!isEdition(input.documentId, input.projectId) ||
				store.publishedBuildId !== input.expectedPublishedBuildId ||
				store.contentRevision !== input.expectedContentRevision ||
				store.currentBuildId !== null
			) {
				return { outcome: "superseded" };
			}
			store.content = structuredClone(input.content);
			store.contentRevision += 1;
			store.extractionCache.set(input.cacheEntry.cacheKey, {
				sectionKey: input.cacheEntry.sectionKey,
				output: structuredClone(input.cacheEntry.output),
			});
			if (store.decisions.get(input.visualKey)?.decision === "ACCEPTED") {
				store.decisions.delete(input.visualKey);
			}
			return {
				outcome: "applied",
				contentRevision: store.contentRevision,
			};
		},
	);
	mocks.upsertVisualDecision.mockImplementation(
		async (input: {
			documentId: string;
			projectId: string;
			visualKey: string;
			sectionKey: string;
			decision: "ACCEPTED" | "DISCARDED";
			specHash?: string | null;
			decidedById: string;
		}) => {
			if (!isEdition(input.documentId, input.projectId)) {
				return null;
			}
			const row: StoredDecision = {
				visualKey: input.visualKey,
				sectionKey: input.sectionKey,
				decision: input.decision,
				specHash: input.specHash ?? null,
				decidedById: input.decidedById,
				updatedAt: DECIDED_AT,
			};
			store.decisions.set(input.visualKey, row);
			return { ...row };
		},
	);
	mocks.clearVisualDecision.mockImplementation(
		async (input: {
			documentId: string;
			projectId: string;
			visualKey: string;
		}) =>
			isEdition(input.documentId, input.projectId) &&
			store.decisions.delete(input.visualKey),
	);
	return store;
}
