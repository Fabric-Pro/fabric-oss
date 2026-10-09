/**
 * Shared world for the Proposal artifact procedure tests (Fizzy #2801).
 *
 * Two organizations, three projects, and one user per access path:
 *
 *  - `owner`        — org A owner, creator of project A;
 *  - `editor`       — org A member with an EDITOR row on project A;
 *  - `memberViewer` — org A member with a VIEWER row on project A;
 *  - `guestEditor`  — an EDITOR row on project A, no org A membership (a
 *                     project guest whose session names org G, their own);
 *  - `guestViewer`  — a VIEWER row on project A, no org A membership;
 *  - `outsider`     — org B owner, creator of project B.
 *
 * Project A2 is a second org A project, so a document id from one project
 * can be paired with the other's id.
 *
 * The decisions are the real ones: the rollout gate middleware, the project
 * permission check and the shared access loader run against this world
 * through a fake `db`. The analysis and style queries are mocks the tests
 * drive and inspect.
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
export const ORG_B = "org-b";
/** The guest's own workspace: what their session names. */
export const ORG_GUEST = "org-guest";
export const PROJECT_A = "proj-a";
export const PROJECT_A2 = "proj-a2";
export const PROJECT_B = "proj-b";
export const DOC_A = "doc-a";
export const DOC_A2 = "doc-a2";
export const DOC_B = "doc-b";
export const DOC_PRD = "doc-prd";

export const USERS = {
	owner: "user-owner",
	editor: "user-editor",
	memberViewer: "user-member-viewer",
	guestEditor: "user-guest-editor",
	guestViewer: "user-guest-viewer",
	outsider: "user-outsider",
} as const;

export const PROPOSAL_BODY = [
	"# Example Proposal",
	"",
	"## Executive Summary",
	"",
	"We propose a pilot for Example Org.",
].join("\n");

interface WorldDocument {
	id: string;
	projectId: string;
	type: string;
	content: string;
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
	/** The PROPOSAL_ARTIFACT rollout gate, per organization. */
	flags: Map<string, boolean>;
}

function createWorld(): World {
	const document = (
		id: string,
		projectId: string,
		overrides: Partial<WorldDocument> = {},
	): [string, WorldDocument] => [
		id,
		{
			id,
			projectId,
			type: "PROPOSAL",
			content: PROPOSAL_BODY,
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
				PROJECT_A2,
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
			document(DOC_A, PROJECT_A),
			document(DOC_A2, PROJECT_A2),
			document(DOC_B, PROJECT_B),
			document(DOC_PRD, PROJECT_A, { type: "PRD" }),
		]),
		orgMembers: new Map([
			[`${ORG_A}:${USERS.owner}`, "owner"],
			[`${ORG_A}:${USERS.editor}`, "member"],
			[`${ORG_A}:${USERS.memberViewer}`, "member"],
			[`${ORG_B}:${USERS.outsider}`, "owner"],
			[`${ORG_GUEST}:${USERS.guestEditor}`, "owner"],
			[`${ORG_GUEST}:${USERS.guestViewer}`, "owner"],
		]),
		projectMembers: new Map([
			[`${PROJECT_A}:${USERS.editor}`, "EDITOR"],
			[`${PROJECT_A}:${USERS.memberViewer}`, "VIEWER"],
			[`${PROJECT_A}:${USERS.guestEditor}`, "EDITOR"],
			[`${PROJECT_A}:${USERS.guestViewer}`, "VIEWER"],
		]),
		flags: new Map([
			[ORG_A, true],
			[ORG_B, true],
		]),
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
	getLatestAnalysisForDocument: vi.fn(),
	getDocumentStyle: vi.fn(),
	upsertDocumentStyle: vi.fn(),
	/** A spy over the world's membership rule, unless a test replaces it. */
	isOrganizationMember: vi.fn(),
};

export function resetMocks(): void {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
	mocks.getLatestAnalysisForDocument.mockResolvedValue(null);
	mocks.getDocumentStyle.mockResolvedValue(null);
	mocks.isOrganizationMember.mockImplementation(
		async (userId: string, organizationId: string) =>
			orgMemberRole(organizationId, userId) !== undefined,
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
			return project
				? {
						id: where.id,
						...project,
						organization: { deletedAt: null },
					}
				: null;
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
					}
				: null;
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
		// PROJECT_UPDATE by the same precedence the middleware uses.
		canEditProject: async (projectId: string, userId: string) => {
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
			return hasPermission(granted, Permissions.PROJECT_UPDATE);
		},
		isOrganizationMember: mocks.isOrganizationMember,
		getLatestAnalysisForDocument: mocks.getLatestAnalysisForDocument,
		getDocumentStyle: mocks.getDocumentStyle,
		upsertDocumentStyle: mocks.upsertDocumentStyle,
	};
}

/**
 * A stand-in for the oRPC builder that records each procedure's middleware
 * chain in order — the real rollout gate middleware, and a marker for the
 * permission middleware — plus its schemas and handler.
 */
export async function proceduresModule() {
	const state: {
		chain: unknown[];
		input?: unknown;
		output?: unknown;
	} = { chain: [] };
	const builder: Record<string, unknown> = {};
	Object.assign(builder, {
		use: (middleware: unknown) => {
			state.chain.push(middleware);
			return builder;
		},
		route: () => builder,
		input: (schema: unknown) => {
			state.input = schema;
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
				__input: state.input,
				__output: state.output,
			};
			state.chain = [];
			state.input = undefined;
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
	safeParse: (value: unknown) => { success: boolean };
};

type Middleware = (
	options: { next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;

type Wired = {
	__handler: (args: {
		input: Record<string, unknown>;
		context: unknown;
	}) => Promise<unknown>;
	__chain: unknown[];
	__input: Schema;
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
 * Run a procedure as `userId`: its input schema, then its middleware chain
 * in declared order (the real gate middleware, then the real permission
 * decision), the handler, and finally its output schema — so a result the
 * wire would reject fails the test.
 */
export async function call(
	procedure: unknown,
	rawInput: Record<string, unknown>,
	userId: string = USERS.editor,
): Promise<unknown> {
	if (!assertProjectPermission) {
		throw new Error(
			"Call usePermissionCheck(assertProjectPermission) first",
		);
	}
	const check = assertProjectPermission;
	const wired = procedure as Wired;
	const input = wired.__input.parse(rawInput) as Record<string, unknown>;
	const context = {
		user: { id: userId, name: "Someone", email: `${userId}@example.com` },
		session: {
			id: "session-1",
			activeOrganizationId: sessionOrganizationFor(userId),
		},
	};

	const run = async (index: number): Promise<{ output: unknown }> => {
		if (index === wired.__chain.length) {
			return { output: await wired.__handler({ input, context }) };
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
