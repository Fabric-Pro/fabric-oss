/**
 * Shared world for the Proposal artifact procedure tests (Fizzy #2801,
 * Fizzy #2946).
 *
 * Two organizations, three projects, and one user per access path:
 *
 *  - `owner`           — org A owner, creator of project A;
 *  - `editor`          — org A member with an EDITOR row on project A;
 *  - `memberViewer`    — org A member with a VIEWER row on project A;
 *  - `memberCommenter` — org A member with a COMMENTER row on project A;
 *  - `guestEditor`     — an EDITOR row on project A, no org A membership (a
 *                        project guest whose session names org G, their own);
 *  - `guestViewer`     — a VIEWER row on project A, no org A membership;
 *  - `outsider`        — org B owner, creator of project B.
 *
 * Project A2 is a second org A project, so a document id from one project
 * can be paired with the other's id. The world's ids and rows live in
 * `proposal-artifact-world.ts`; this module re-exports them.
 *
 * The decisions are the real ones: the rollout gate middleware, the project
 * permission check and the shared access loader run against this world
 * through a fake `db`. The analysis, response, style and evidence-source
 * queries are mocks the tests drive and inspect; the response writes default
 * to an in-memory store, so a test can answer and then read, and the
 * evidence read answers from the world's context rows as they are now.
 *
 * Each test file wires this in with its own `vi.mock` calls (they must live
 * in the test file to be hoisted); the factories import this module lazily,
 * so it never statically imports a module the tests mock.
 */

import { ORPCError } from "@orpc/client";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { vi } from "vitest";
import {
	ORG_A,
	ORG_B,
	ORG_GUEST,
	USER_NAMES,
	USERS,
	type WorldResponse,
	world,
} from "./proposal-artifact-world";

export {
	DOC_A,
	DOC_A2,
	DOC_B,
	DOC_PRD,
	ORG_A,
	ORG_A_SLUG,
	ORG_B,
	ORG_GUEST,
	PROJECT_A,
	PROJECT_A2,
	PROJECT_B,
	PROPOSAL_BODY,
	resetWorld,
	USER_NAMES,
	USERS,
	type WorldCompanySource,
	type WorldContext,
	type WorldFinding,
	type WorldResponse,
	type WorldRun,
	world,
} from "./proposal-artifact-world";

// ---------------------------------------------------------------------------
// Mocks the tests drive
// ---------------------------------------------------------------------------

export const mocks = {
	getAnalysisForCurrentContent: vi.fn(),
	/** The shown run's report; none unless a test gives one. */
	getAnalysisReport: vi.fn(),
	listResponsesForDocument: vi.fn(),
	upsertFindingResponse: vi.fn(),
	clearFindingResponse: vi.fn(),
	claimRerun: vi.fn(),
	failAnalysisRun: vi.fn(),
	getDocumentStyle: vi.fn(),
	upsertDocumentStyle: vi.fn(),
	/** The audit writer `recordAuditFromRequest` hands each row to. */
	recordAudit: vi.fn(),
	/** A spy over the world's membership rule, unless a test replaces it. */
	isOrganizationMember: vi.fn(),
	/** The shared internal predicate over the world, unless a test replaces it. */
	isProposalInternalReader: vi.fn(),
	/** The evidence-source read, answering from the world's rows. */
	readProposalEvidenceSources: vi.fn(),
};

/** How much of a row's text the real evidence read takes. */
const EVIDENCE_TEXT_HEAD_LENGTH = 2000;

/**
 * The evidence-source read with the real query's filter: contexts in this
 * project and organization, company sources of this organization and not
 * being deleted, the opening of each row's current text, and no address.
 */
async function fakeReadProposalEvidenceSources(input: {
	organizationId: string;
	projectId: string;
	contextIds: readonly string[];
	companySourceIds: readonly string[];
}) {
	const contexts = [...new Set(input.contextIds)].flatMap((id) => {
		const row = world.contexts.get(id);
		return row &&
			row.projectId === input.projectId &&
			row.organizationId === input.organizationId
			? [
					{
						id,
						type: row.type,
						sourceTitle: row.sourceTitle ?? null,
						originalFilename: row.originalFilename ?? null,
						sourcePath: row.sourcePath ?? null,
						contentHead: (row.content ?? "").slice(
							0,
							EVIDENCE_TEXT_HEAD_LENGTH,
						),
					},
				]
			: [];
	});
	const companySources = [...new Set(input.companySourceIds)].flatMap(
		(id) => {
			const row = world.companySources.get(id);
			return row &&
				row.organizationId === input.organizationId &&
				row.deletingAt === null
				? [
						{
							id,
							sourceTitle: row.sourceTitle ?? null,
							originalFilename: row.originalFilename ?? null,
							contentHead: (row.content ?? "").slice(
								0,
								EVIDENCE_TEXT_HEAD_LENGTH,
							),
						},
					]
				: [];
		},
	);
	return { contexts, companySources };
}

let responseSequence = 0;

/** The columns `FindingResponseCurrent` selects. */
function currentOf(response: WorldResponse) {
	return {
		id: response.id,
		kind: response.kind,
		text: response.text,
		authorId: response.authorId,
		version: response.version,
		updatedAt: response.updatedAt,
	};
}

function findResponse(organizationId: string, documentId: string, key: string) {
	return world.responses.find(
		(response) =>
			response.organizationId === organizationId &&
			response.documentId === documentId &&
			response.stableKey === key,
	);
}

/**
 * The response queries as an in-memory compare-and-swap with the real
 * contract: no `expectedResponseId` and `expectedVersion` only creates; given
 * together they only replace that exact row at that exact version, so an
 * answer cleared and given again (a new row, back at version 1) is never
 * taken for the one the member saw. A refused write answers `stale` with the
 * saved answer (or null when there is none).
 */
async function fakeUpsertFindingResponse(input: {
	organizationId: string;
	projectId: string;
	documentId: string;
	stableKey: string;
	kind: "CONFIRMED" | "RESPONDED";
	text?: string | null;
	findingTitle: string;
	answeredRunId: string;
	sectionKey: string;
	sectionHash: string;
	authorId: string | null;
	expectedResponseId?: string;
	expectedVersion?: number;
}) {
	if (
		(input.expectedResponseId === undefined) !==
		(input.expectedVersion === undefined)
	) {
		throw new TypeError(
			"expectedResponseId and expectedVersion are given together or not at all",
		);
	}
	const existing = findResponse(
		input.organizationId,
		input.documentId,
		input.stableKey,
	);
	const now = new Date(Date.now() + responseSequence++);
	const fields = {
		kind: input.kind,
		text: input.text?.trim() ? input.text.trim() : null,
		findingTitle: input.findingTitle,
		answeredRunId: input.answeredRunId,
		sectionKey: input.sectionKey,
		sectionHash: input.sectionHash,
		authorId: input.authorId,
		updatedAt: now,
	};
	if (input.expectedVersion === undefined) {
		if (existing) {
			return { outcome: "stale" as const, current: currentOf(existing) };
		}
		const created: WorldResponse = {
			id: `response-${responseSequence}`,
			organizationId: input.organizationId,
			projectId: input.projectId,
			documentId: input.documentId,
			stableKey: input.stableKey,
			version: 1,
			createdAt: now,
			...fields,
		};
		world.responses.push(created);
		return { outcome: "written" as const, response: { ...created } };
	}
	if (
		!existing ||
		existing.id !== input.expectedResponseId ||
		existing.version !== input.expectedVersion
	) {
		return {
			outcome: "stale" as const,
			current: existing ? currentOf(existing) : null,
		};
	}
	Object.assign(existing, fields, { version: existing.version + 1 });
	return { outcome: "written" as const, response: { ...existing } };
}

/** Clears only that exact row at that exact version, likewise. */
async function fakeClearFindingResponse(input: {
	organizationId: string;
	documentId: string;
	stableKey: string;
	responseId: string;
	version: number;
}) {
	const existing = findResponse(
		input.organizationId,
		input.documentId,
		input.stableKey,
	);
	if (!existing) {
		return { outcome: "not_found" as const };
	}
	if (
		existing.id !== input.responseId ||
		existing.version !== input.version
	) {
		return { outcome: "stale" as const, current: currentOf(existing) };
	}
	world.responses = world.responses.filter(
		(response) => response !== existing,
	);
	return { outcome: "cleared" as const, kind: existing.kind };
}

export function resetMocks(): void {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.getAnalysisForCurrentContent.mockResolvedValue({
		run: null,
		isStale: false,
		newerRun: null,
	});
	mocks.getAnalysisReport.mockResolvedValue(null);
	mocks.listResponsesForDocument.mockImplementation(
		async (input: { organizationId: string; documentId: string }) =>
			world.responses
				.filter(
					(response) =>
						response.organizationId === input.organizationId &&
						response.documentId === input.documentId,
				)
				.map((response) => ({ ...response })),
	);
	mocks.upsertFindingResponse.mockImplementation(fakeUpsertFindingResponse);
	mocks.clearFindingResponse.mockImplementation(fakeClearFindingResponse);
	mocks.failAnalysisRun.mockResolvedValue("written");
	mocks.getDocumentStyle.mockResolvedValue(null);
	mocks.isOrganizationMember.mockImplementation(
		async (userId: string, organizationId: string) =>
			orgMemberRole(organizationId, userId) !== undefined,
	);
	mocks.isProposalInternalReader.mockImplementation(
		async (args: {
			organizationId: string | null | undefined;
			documentType: string;
			userId: string;
		}) =>
			args.documentType === "PROPOSAL" &&
			Boolean(args.organizationId) &&
			(world.flags.get(args.organizationId as string) ?? false) &&
			(await mocks.isOrganizationMember(
				args.userId,
				args.organizationId as string,
			)),
	);
	mocks.readProposalEvidenceSources.mockImplementation(
		fakeReadProposalEvidenceSources,
	);
}

/** Every audit row the procedures handed to the writer, in order. */
export function auditRows(): Array<Record<string, unknown>> {
	return mocks.recordAudit.mock.calls.map(
		([row]) => row as Record<string, unknown>,
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

/**
 * A project permission by the middleware's precedence: an active project
 * member row decides alone, else the organization role.
 */
function projectPermissionHolds(
	projectId: string,
	userId: string,
	permission: string,
): boolean {
	const project = world.projects.get(projectId);
	if (!project) {
		return false;
	}
	const member = projectMemberRole(projectId, userId);
	const granted = member
		? resolveProjectPermissions(member as never)
		: resolveOrgPermissions(
				orgMemberRole(project.organizationId, userId) as never,
			);
	return hasPermission(granted, permission as never);
}

function idsIn(where: { id?: { in?: string[] } }): string[] {
	return where.id?.in ?? [];
}

const fakeDb = {
	project: {
		findUnique: async ({ where }: { where: { id: string } }) => {
			const project = world.projects.get(where.id);
			return project
				? {
						id: where.id,
						...project,
						organization: { deletedAt: null },
					}
				: null;
		},
	},
	organization: {
		findUnique: async ({ where }: { where: { id: string } }) => {
			const organization = world.organizations.get(where.id);
			return organization ? { id: where.id, ...organization } : null;
		},
	},
	user: {
		findMany: async ({ where }: { where: { id?: { in?: string[] } } }) =>
			idsIn(where)
				.filter((id) => id in USER_NAMES)
				.map((id) => ({ id, name: USER_NAMES[id] })),
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
	projectDocument: {
		findFirst: async ({
			where,
		}: {
			where: { id: string; projectId: string };
		}) => {
			const document = world.documents.get(where.id);
			return document && document.projectId === where.projectId
				? {
						id: document.id,
						type: document.type,
						content: document.content,
						status: document.status ?? "COMPLETE",
					}
				: null;
		},
	},
	projectDocumentAnalysis: {
		findFirst: async ({
			where,
		}: {
			where: { id: string; documentId: string; organizationId: string };
		}) => {
			const run = world.runs.get(where.id);
			return run &&
				run.documentId === where.documentId &&
				run.organizationId === where.organizationId
				? {
						id: run.id,
						proseHash: run.proseHash,
						sourceRunId: run.sourceRunId,
					}
				: null;
		},
	},
	projectDocumentFinding: {
		findFirst: async ({
			where,
		}: {
			where: { id: string; analysisId: string; organizationId: string };
		}) => {
			const run = world.runs.get(where.analysisId);
			if (!run || run.organizationId !== where.organizationId) {
				return null;
			}
			const finding = run.findings.find(
				(candidate) => candidate.id === where.id,
			);
			return finding ? { ...finding } : null;
		},
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
		isFeatureEnabled: async (flag: string, organizationId?: string) =>
			flag === "PROPOSAL_ARTIFACT" &&
			Boolean(organizationId) &&
			(world.flags.get(organizationId as string) ?? false),
		resolveProjectTenant: async (projectId: string) => {
			const project = world.projects.get(projectId);
			return project
				? { organizationId: project.organizationId, userId: null }
				: null;
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
		// PROJECT_UPDATE and DOCUMENT_UPDATE by the same precedence the
		// middleware uses.
		canEditProject: async (projectId: string, userId: string) =>
			projectPermissionHolds(
				projectId,
				userId,
				Permissions.PROJECT_UPDATE,
			),
		canUpdateProjectDocuments: async (projectId: string, userId: string) =>
			projectPermissionHolds(
				projectId,
				userId,
				Permissions.DOCUMENT_UPDATE,
			),
		isOrganizationMember: mocks.isOrganizationMember,
		// The real rule over the fakes above: membership (through the spy, so a
		// test that replaces it governs authors too), then DOCUMENT_UPDATE.
		authorMaySettleDecisions: async (
			userId: string,
			projectId: string,
			organizationId: string,
		) =>
			(await mocks.isOrganizationMember(userId, organizationId)) &&
			projectPermissionHolds(
				projectId,
				userId,
				Permissions.DOCUMENT_UPDATE,
			),
		// The shared predicates over the fakes above (the actual ones would
		// reach the real flag store and member table).
		isProposalClientDocument: async (args: {
			organizationId: string | null | undefined;
			documentType: string;
		}) =>
			args.documentType === "PROPOSAL" &&
			Boolean(args.organizationId) &&
			(world.flags.get(args.organizationId as string) ?? false),
		isProposalInternalReader: mocks.isProposalInternalReader,
		getAnalysisForCurrentContent: mocks.getAnalysisForCurrentContent,
		getAnalysisReport: mocks.getAnalysisReport,
		listResponsesForDocument: mocks.listResponsesForDocument,
		upsertFindingResponse: mocks.upsertFindingResponse,
		clearFindingResponse: mocks.clearFindingResponse,
		claimRerun: mocks.claimRerun,
		failAnalysisRun: mocks.failAnalysisRun,
		getDocumentStyle: mocks.getDocumentStyle,
		upsertDocumentStyle: mocks.upsertDocumentStyle,
		recordAudit: mocks.recordAudit,
		readProposalEvidenceSources: mocks.readProposalEvidenceSources,
	};
}

/**
 * A stand-in for the oRPC builder that records each procedure's middleware
 * chain in order — the real rollout gate middleware, and a marker for the
 * permission middleware — plus its route, schemas and handler, and where in
 * the chain the input is validated: as oRPC does, after the middleware
 * declared before `.input()`.
 */
export async function proceduresModule() {
	const state: {
		chain: unknown[];
		route?: unknown;
		input?: unknown;
		inputIndex?: number;
		output?: unknown;
	} = { chain: [] };
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		use: (middleware: unknown) => {
			state.chain.push(middleware);
			return builder;
		},
		route: (route: unknown) => {
			state.route = route;
			return builder;
		},
		input: (schema: unknown) => {
			state.input = schema;
			state.inputIndex = state.chain.length;
			return builder;
		},
		output: (schema: unknown) => {
			state.output = schema;
			return builder;
		},
		handler: (fn: unknown) => {
			const wired = {
				__handler: fn,
				__chain: state.chain,
				__route: state.route,
				__input: state.input,
				__inputIndex: state.inputIndex ?? state.chain.length,
				__output: state.output,
			};
			state.chain = [];
			state.route = undefined;
			state.input = undefined;
			state.inputIndex = undefined;
			state.output = undefined;
			return wired;
		},
	});
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: (permission: string) => ({
			__permission: permission,
		}),
		Permissions,
	};
}

// ---------------------------------------------------------------------------
// Calling a procedure
// ---------------------------------------------------------------------------

type Schema = {
	parse: (value: unknown) => unknown;
	safeParse: (
		value: unknown,
	) =>
		| { success: true; data: unknown }
		| { success: false; error: { issues: unknown[] } };
};

type Middleware = (
	options: { next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
		signal?: AbortSignal;
	}) => Promise<unknown>;
	__chain: unknown[];
	__route: { method?: string; path?: string } | undefined;
	__input: Schema;
	/** The chain position at which the input is validated. */
	__inputIndex: number;
	__output: Schema;
};

type AssertProjectPermission = (
	projectId: string,
	userId: string,
	permission: never,
) => Promise<unknown>;

let assertProjectPermission: AssertProjectPermission | null = null;

/**
 * The real permission decision, handed in by each test file from its own
 * static import: a module this harness imported itself could resolve
 * `@repo/database` past the test file's mock.
 */
export function usePermissionCheck(check: AssertProjectPermission): void {
	assertProjectPermission = check;
}

/** The session organization each user works from. */
function sessionOrganizationFor(userId: string): string {
	switch (userId) {
		case USERS.outsider:
			return ORG_B;
		case USERS.guestEditor:
		case USERS.guestViewer:
			return ORG_GUEST;
		default:
			return ORG_A;
	}
}

/**
 * Run a procedure as `userId`: its middleware chain in declared order (the
 * real gate middleware, then the real permission decision) with its input
 * schema checked where oRPC checks it — a refused input fails as oRPC's
 * BAD_REQUEST, carrying the schema's issues as its cause — the handler, and
 * finally its output schema, so a result the wire would reject fails the
 * test, and a field the schema does not declare never reaches it.
 */
export async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string = USERS.editor,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<unknown> {
	if (!assertProjectPermission) {
		throw new Error(
			"Call usePermissionCheck(assertProjectPermission) first",
		);
	}
	const check = assertProjectPermission;
	const wired = procedure as Wired;
	// Middleware before the input check sees the input as sent.
	let input: Record<string, unknown> = rawInput;
	const context = {
		user: {
			id: userId,
			name: USER_NAMES[userId] ?? "Someone",
			email: `${userId}@example.com`,
		},
		session: {
			id: "session-1",
			activeOrganizationId: sessionOrganizationFor(userId),
		},
	};

	const run = async (index: number): Promise<{ output: unknown }> => {
		if (index === wired.__inputIndex) {
			const parsed = wired.__input.safeParse(rawInput);
			if (!parsed.success) {
				throw new ORPCError("BAD_REQUEST", {
					message: "Input validation failed",
					cause: parsed.error,
				});
			}
			input = parsed.data as Record<string, unknown>;
		}
		if (index === wired.__chain.length) {
			return {
				output: await wired.__handler({ input, context, signal }),
			};
		}
		const middleware = wired.__chain[index];
		if (
			middleware &&
			typeof middleware === "object" &&
			"__permission" in middleware
		) {
			await check(
				input.projectId as string,
				userId,
				(middleware as { __permission: string }).__permission as never,
			);
			return run(index + 1);
		}
		return (await (middleware as Middleware)(
			{ next: () => run(index + 1) },
			input,
		)) as { output: unknown };
	};

	const { output } = await run(0);
	return wired.__output.parse(output);
}

/** The declared permission of a procedure's permission middleware. */
export function declaredPermission(procedure: unknown): string | undefined {
	const marker = (procedure as Wired).__chain.find(
		(middleware) =>
			middleware !== null &&
			typeof middleware === "object" &&
			"__permission" in middleware,
	) as { __permission: string } | undefined;
	return marker?.__permission;
}

/** The procedure's declared REST route. */
export function declaredRoute(
	procedure: unknown,
): { method?: string; path?: string } | undefined {
	return (procedure as Wired).__route;
}

/** The procedure's input schema, for validation cases. */
export function inputSchema(procedure: unknown): Schema {
	return (procedure as Wired).__input;
}

/** The thrown oRPC error's code and data, or fails when nothing was thrown. */
export async function refusal(
	promise: Promise<unknown>,
): Promise<{ code?: string; message?: string; data?: unknown }> {
	try {
		await promise;
	} catch (error) {
		const { code, message, data } = error as {
			code?: string;
			message?: string;
			data?: unknown;
		};
		return { code, message, data };
	}
	throw new Error("Expected the call to throw");
}

/** A schema issue, as an input refusal carries it. */
export interface InputIssue {
	path: PropertyKey[];
	message: string;
	params?: Record<string, unknown>;
}

/**
 * The thrown input refusal's code and the schema issues behind it, or fails
 * when nothing was thrown.
 */
export async function inputRefusal(
	promise: Promise<unknown>,
): Promise<{ code?: string; issues: InputIssue[] }> {
	try {
		await promise;
	} catch (error) {
		const { code, cause } = error as {
			code?: string;
			cause?: { issues?: InputIssue[] };
		};
		return { code, issues: cause?.issues ?? [] };
	}
	throw new Error("Expected the call to throw");
}
