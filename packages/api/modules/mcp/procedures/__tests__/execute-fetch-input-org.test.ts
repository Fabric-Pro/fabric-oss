/**
 * `mcp.tools.execute`, `mcp.resources.fetch` and `mcp.configs.createSession`
 * take an organization from the caller's input. Through the real permission code (the procedures' own
 * `requirePermission` middleware, the in-handler `authorizeInputOrganization`
 * and the real role table), they must:
 *  - refuse an organization the caller is not a member of before any MCP
 *    config is read, even when the caller still owns a config there (a saved
 *    config outlives its owner's membership);
 *  - refuse a member whose role there lacks the permission (a viewer may
 *    read resources but not execute tools);
 *  - read the config only in the organization that was authorized;
 *  - check the role in the NAMED organization, not the session's;
 *  - refuse a soft-deleted named organization;
 *  - keep personal context (`organizationId: null`) on personal configs.
 * Only the membership lookup, the config query and the session-token writer
 * are stand-ins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	/** organizationId -> userId -> role */
	members: {} as Record<string, Record<string, string>>,
	/** Organizations that are soft-deleted. */
	deleted: new Set<string>(),
	/** Whether the config lookup finds the caller's config. */
	configFound: false,
	sessionsMinted: [] as Array<{ configId: string; organizationId?: string }>,
	configLookups: [] as Array<{
		id: string;
		opts?: { userId: string; organizationId?: string };
	}>,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getOrganizationMembership: async (
			organizationId: string,
			userId: string,
		) => {
			const role = state.members[organizationId]?.[userId];
			return role
				? {
						organization: {
							id: organizationId,
							deletedAt: state.deleted.has(organizationId)
								? new Date()
								: null,
						},
						role,
					}
				: null;
		},
		// By default no config is found, so a call that gets past
		// authorization stops at CONFIG_NOT_FOUND without contacting any MCP
		// server. createSession tests turn it on to reach the token writer.
		getMcpConfigById: async (
			id: string,
			opts?: { userId: string; organizationId?: string },
		) => {
			state.configLookups.push({ id, opts });
			return state.configFound
				? {
						id,
						userId: opts?.userId,
						organizationId: opts?.organizationId ?? null,
					}
				: null;
		},
		createMcpClientSession: async (opts: {
			configId: string;
			organizationId?: string;
		}) => {
			state.sessionsMinted.push({
				configId: opts.configId,
				organizationId: opts.organizationId,
			});
			return { token: "token-1", expiresAt: new Date(0) };
		},
	};
});

// configs.ts (createSession's module) imports this for its other procedures.
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async (
		organizationId: string,
		userId: string,
	) => {
		const role = state.members[organizationId]?.[userId];
		return role ? { role } : null;
	},
}));

import { PERMISSION_MIDDLEWARE_TAG } from "../../../../orpc/middleware/require-permission";
import { configProcedures } from "../configs";
import { executeToolProcedure } from "../execute-tool";
import { fetchResourcesProcedure } from "../fetch-resources";

const USER = "user-1";
const ORG = "example-org";
const OTHER_ORG = "other-org";

type Definition = {
	"~orpc": {
		middlewares: unknown[];
		handler: (options: Record<string, unknown>) => Promise<unknown>;
	};
};

/**
 * Run every permission middleware the procedure declares (the real ones),
 * then its handler, for a caller whose active organization is `session.org`
 * with role `session.role` there.
 */
async function call(
	procedure: unknown,
	input: Record<string, unknown>,
	session: { org: string | null; role?: string | null } = {
		org: ORG,
		role: "member",
	},
): Promise<any> {
	const def = (procedure as Definition)["~orpc"];
	const permissionMiddlewares = def.middlewares.filter(
		(mw) =>
			typeof mw === "function" &&
			(mw as unknown as Record<symbol, unknown>)[
				PERMISSION_MIDDLEWARE_TAG
			] !== undefined,
	);
	// A guard against a test that silently runs no permission code at all.
	expect(permissionMiddlewares.length).toBeGreaterThan(0);
	const base = {
		user: { id: USER, email: "dev@example.com", name: "Dev" },
		session: { id: "session-1", activeOrganizationId: session.org },
		tenantContext: session.org
			? {
					userId: USER,
					type: "organization",
					organizationId: session.org,
				}
			: { userId: USER, type: "personal", organizationId: null },
		activeOrganizationRole: session.role ?? null,
		allowedProjectIds: [],
	};
	const step = async (
		index: number,
		context: Record<string, unknown>,
	): Promise<{ output: unknown }> => {
		if (index === permissionMiddlewares.length) {
			return {
				output: await def.handler({
					input,
					context,
					path: [],
					procedure,
					signal: undefined,
					lastEventId: undefined,
					errors: {},
				}),
			};
		}
		const mw = permissionMiddlewares[index] as (
			options: Record<string, unknown>,
			input: unknown,
			output: unknown,
		) => Promise<{ output: unknown }>;
		return mw(
			{
				context,
				path: [],
				procedure,
				signal: undefined,
				lastEventId: undefined,
				errors: {},
				next: (options?: { context?: Record<string, unknown> }) =>
					step(index + 1, {
						...context,
						...(options?.context ?? {}),
					}),
			},
			input,
			undefined,
		);
	};
	return (await step(0, base)).output;
}

const procedures = [
	[
		"mcp.tools.execute",
		executeToolProcedure,
		{ configId: "config-1", toolName: "list_issues", args: {} },
	],
	[
		"mcp.resources.fetch",
		fetchResourcesProcedure,
		{ configId: "config-1", resourceType: "tools" },
	],
] as const;

beforeEach(() => {
	state.members = { [ORG]: { [USER]: "member" } };
	state.deleted = new Set();
	state.configFound = false;
	state.sessionsMinted = [];
	state.configLookups = [];
});

describe("MCP execute and fetch authorize the organization named in the input", () => {
	it.each(procedures)(
		"%s: an organization the caller is not a member of is refused before any config is read",
		async (_name, procedure, input) => {
			await expect(
				call(procedure, { ...input, organizationId: OTHER_ORG }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "You are not a member of this organization",
			});
			expect(state.configLookups).toEqual([]);
		},
	);

	it.each(procedures)(
		"%s: a former member is refused although the session still names that organization",
		async (_name, procedure, input) => {
			state.members = {};
			await expect(
				call(procedure, { ...input, organizationId: ORG }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(state.configLookups).toEqual([]);
		},
	);

	it.each(procedures)(
		"%s: a member's config is read only in the authorized organization",
		async (_name, procedure, input) => {
			await call(procedure, { ...input, organizationId: ORG });
			expect(state.configLookups).toEqual([
				{ id: "config-1", opts: { userId: USER, organizationId: ORG } },
			]);
		},
	);

	it.each(procedures)(
		"%s: personal context stays on the caller's personal configs",
		async (_name, procedure, input) => {
			await call(procedure, { ...input, organizationId: null });
			expect(state.configLookups).toEqual([
				{
					id: "config-1",
					opts: { userId: USER, organizationId: undefined },
				},
			]);
		},
	);

	it("a viewer may fetch resources but not execute tools", async () => {
		state.members[ORG][USER] = "viewer";
		const session = { org: ORG, role: "viewer" };

		await call(
			fetchResourcesProcedure,
			{
				configId: "config-1",
				resourceType: "tools",
				organizationId: ORG,
			},
			session,
		);
		expect(state.configLookups).toHaveLength(1);

		state.configLookups = [];
		await expect(
			call(
				executeToolProcedure,
				{
					configId: "config-1",
					toolName: "list_issues",
					args: {},
					organizationId: ORG,
				},
				session,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.configLookups).toEqual([]);
	});
});

describe("the role and state of the NAMED organization decide", () => {
	it("a viewer in the named organization may fetch but not execute, though the session's organization makes them an admin", async () => {
		state.members = {
			[ORG]: { [USER]: "admin" },
			[OTHER_ORG]: { [USER]: "viewer" },
		};
		const session = { org: ORG, role: "admin" };

		await call(
			fetchResourcesProcedure,
			{
				configId: "config-1",
				resourceType: "tools",
				organizationId: OTHER_ORG,
			},
			session,
		);
		expect(state.configLookups).toEqual([
			{
				id: "config-1",
				opts: { userId: USER, organizationId: OTHER_ORG },
			},
		]);

		state.configLookups = [];
		await expect(
			call(
				executeToolProcedure,
				{
					configId: "config-1",
					toolName: "list_issues",
					args: {},
					organizationId: OTHER_ORG,
				},
				session,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.configLookups).toEqual([]);
	});

	it.each(procedures)(
		"%s: a soft-deleted named organization is refused though the caller is still a member",
		async (_name, procedure, input) => {
			state.members[OTHER_ORG] = { [USER]: "admin" };
			state.deleted.add(OTHER_ORG);
			await expect(
				call(procedure, { ...input, organizationId: OTHER_ORG }),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "This organization has been deleted",
			});
			expect(state.configLookups).toEqual([]);
		},
	);

	it.each(procedures)(
		"%s: an omitted organization resolves to the session's and is still authorized",
		async (_name, procedure, input) => {
			await call(procedure, { ...input });
			expect(state.configLookups).toEqual([
				{ id: "config-1", opts: { userId: USER, organizationId: ORG } },
			]);
		},
	);

	it.each(procedures)(
		"%s: a personal session naming an organization it does not belong to is refused",
		async (_name, procedure, input) => {
			await expect(
				call(
					procedure,
					{ ...input, organizationId: OTHER_ORG },
					{ org: null, role: null },
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(state.configLookups).toEqual([]);
		},
	);
});

describe("mcp.configs.createSession", () => {
	const createSession = configProcedures.createSession;
	const input = { id: "config-1", ttlMinutes: 15 };

	beforeEach(() => {
		state.configFound = true;
	});

	it("refuses an organization the caller is not a member of before any config is read or token minted", async () => {
		await expect(
			call(createSession, { ...input, organizationId: OTHER_ORG }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "You are not a member of this organization",
		});
		expect(state.configLookups).toEqual([]);
		expect(state.sessionsMinted).toEqual([]);
	});

	it("refuses a viewer in the named organization", async () => {
		state.members[OTHER_ORG] = { [USER]: "viewer" };
		await expect(
			call(createSession, { ...input, organizationId: OTHER_ORG }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(state.configLookups).toEqual([]);
		expect(state.sessionsMinted).toEqual([]);
	});

	it("refuses a soft-deleted named organization the caller still belongs to", async () => {
		state.members[OTHER_ORG] = { [USER]: "admin" };
		state.deleted.add(OTHER_ORG);
		await expect(
			call(createSession, { ...input, organizationId: OTHER_ORG }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "This organization has been deleted",
		});
		expect(state.configLookups).toEqual([]);
		expect(state.sessionsMinted).toEqual([]);
	});

	it("mints a token for a member's config only in the authorized organization", async () => {
		await expect(
			call(createSession, { ...input, organizationId: ORG }),
		).resolves.toMatchObject({ token: "token-1" });
		expect(state.configLookups).toEqual([
			{ id: "config-1", opts: { userId: USER, organizationId: ORG } },
		]);
		expect(state.sessionsMinted).toEqual([
			{ configId: "config-1", organizationId: ORG },
		]);
	});

	it.each([
		["null", null],
		["omitted", undefined],
	])(
		"keeps an %s organization on the caller's personal configs",
		async (_name, organizationId) => {
			await call(createSession, { ...input, organizationId });
			expect(state.configLookups).toEqual([
				{
					id: "config-1",
					opts: { userId: USER, organizationId: undefined },
				},
			]);
			expect(state.sessionsMinted).toEqual([
				{ configId: "config-1", organizationId: undefined },
			]);
		},
	);
});
