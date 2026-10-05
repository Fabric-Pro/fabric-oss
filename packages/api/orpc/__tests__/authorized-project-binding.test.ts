/**
 * The authorized-project binding (Fizzy #2904): the permission check records
 * the project it authorized, and the organization resolvers refuse a different
 * input organization and default to the project's.
 *
 * Before it, `requireProjectPermission` authorized (projectId, userId) without
 * looking at the organization and `resolveOrganizationId` returned a non-null
 * input organization verbatim — so a caller with access to any project could
 * name another organization and run AI on its provider key.
 */
import { call, ORPCError, os } from "@orpc/server";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
	resolveEffectiveProjectPermissions: vi.fn(),
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: vi.fn(),
	hasOrganizationTie: vi.fn(),
	getSession: vi.fn(),
	effectiveWriteOrgId: null as string | null,
}));

vi.mock("@repo/payments", () => ({}));
vi.mock("@repo/config", () => ({ config: {} }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (...a: unknown[]) => mocks.getSession(...a) } },
}));
vi.mock("@repo/database", () => ({
	db: {},
	getTenantContext: () => ({
		effectiveWriteOrgId: mocks.effectiveWriteOrgId,
	}),
	getOrganizationMembership: (...a: unknown[]) =>
		mocks.getOrganizationMembership(...a),
	grantProjectAccess: (...a: unknown[]) => mocks.grantProjectAccess(...a),
	hasOrganizationTie: (...a: unknown[]) => mocks.hasOrganizationTie(...a),
	StoryVersionConflictError: class extends Error {},
}));
vi.mock("../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		mocks.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../../lib/rate-limit", () => ({
	checkRateLimit: async () => ({
		allowed: true,
		remaining: 1,
		resetInSeconds: 60,
	}),
	RATE_LIMIT_PRESETS: {},
}));

// The observability and audit middlewares are not what these tests are about,
// and each reaches a database; pass them through so the chain under test is
// the REAL root → session → permission → handler order.
const { passThrough } = vi.hoisted(() => ({
	passThrough: async () => {
		const { os: orpc } = await import("@orpc/server");
		return orpc.middleware(async ({ next }) => next());
	},
}));
vi.mock("../middleware/request-counter-middleware", async () => ({
	requestCounterMiddleware: await passThrough(),
}));
vi.mock("../middleware/error-metrics-middleware", async () => ({
	errorMetricsMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-error-middleware", async (importOriginal) => ({
	// The real `auditOrganizationId` is under test below.
	...(await importOriginal<
		typeof import("../middleware/audit-error-middleware")
	>()),
	auditErrorMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-timing-middleware", async () => ({
	auditTimingMiddleware: await passThrough(),
}));
vi.mock("../middleware/audit-activity-middleware", async () => ({
	auditActivityMiddleware: await passThrough(),
}));
vi.mock("../middleware/touch-last-seen", async () => ({
	touchLastSeenMiddleware: await passThrough(),
}));
vi.mock("../middleware/rpc-rate-limit-middleware", async () => ({
	rpcRateLimitMiddleware: await passThrough(),
}));
vi.mock("../middleware/tenant-context-middleware", async () => ({
	tenantContextMiddleware: await passThrough(),
	getOrganizationIdFromContext: vi.fn(),
	getTenantFilterFromContext: vi.fn(),
}));

import {
	assertProjectBindable,
	hasProjectBindingHolder,
	peekAuthorizedProject,
	recordAuthorizedProject,
	resolveBoundOrganization,
	runWithProjectBindingHolder,
} from "../../lib/authorized-project-binding";
import { DELETED_ORGANIZATION_ERROR_CODE } from "../../lib/deleted-organization";
import { auditOrganizationId } from "../middleware/audit-error-middleware";
import {
	assertProjectPermission,
	authorizeInputOrganization,
	protectedProcedure,
	publicProcedure,
	requireProjectPermission,
	resolveOrganizationId,
	resolveOrganizationIdForCaller,
	resolveSourceCredentialOrganizationId,
} from "../procedures";

const ORG_A = "org-example-alpha";
const ORG_B = "org-example-bravo";
const USER = "user-example-1";

function access(
	source: "owner" | "project-member" | "org" | "none",
	organizationId: string | null,
	extra: { organizationDeleted?: boolean; permissions?: string[] } = {},
) {
	return {
		source,
		organizationId,
		permissions:
			extra.permissions ??
			(source === "none" ? [] : [Permissions.PROJECT_READ]),
		organizationDeleted: extra.organizationDeleted ?? false,
	};
}

/** Run `fn` inside a fresh holder, as every oRPC call does. */
function inRequest<T>(fn: () => T): T {
	return runWithProjectBindingHolder(fn);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.effectiveWriteOrgId = null;
	mocks.hasOrganizationTie.mockResolvedValue(true);
	mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
	mocks.getSession.mockResolvedValue({
		session: { activeOrganizationId: null },
		user: { id: USER },
	});
});

describe("the binding store", () => {
	it("has no holder outside a request: nothing is recorded and nothing is bound", () => {
		expect(hasProjectBindingHolder()).toBe(false);
		expect(
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A }),
		).toBe(false);
		expect(peekAuthorizedProject()).toBeNull();
		expect(resolveBoundOrganization(ORG_B)).toEqual({ bound: false });
	});

	it("distinguishes 'nothing authorized' from 'a project with no organization'", () => {
		inRequest(() => {
			expect(peekAuthorizedProject()).toBeNull();
			recordAuthorizedProject({ projectId: "p", organizationId: null });
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p",
				organizationId: null,
			});
		});
	});

	it("records an immutable binding", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			const bound = peekAuthorizedProject();
			expect(Object.isFrozen(bound)).toBe(true);
		});
	});

	it("is idempotent for the same organization and keeps the first project", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p1", organizationId: ORG_A });
			recordAuthorizedProject({ projectId: "p1", organizationId: ORG_A });
			recordAuthorizedProject({ projectId: "p2", organizationId: ORG_A });
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p1",
				organizationId: ORG_A,
			});
		});
	});

	it("refuses a second binding in another organization with a typed error, leaving the first", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p1", organizationId: ORG_A });
			let thrown: unknown;
			try {
				recordAuthorizedProject({
					projectId: "p2",
					organizationId: ORG_B,
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(ORPCError);
			expect(thrown).toMatchObject({ code: "BAD_REQUEST" });
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p1",
				organizationId: ORG_A,
			});
			expect(() =>
				assertProjectBindable({
					projectId: "p3",
					organizationId: null,
				}),
			).toThrow(ORPCError);
		});
	});

	it("keeps two concurrent requests' bindings apart", async () => {
		let releaseA: () => void = () => {};
		const aMayFinish = new Promise<void>((r) => {
			releaseA = r;
		});
		const requestA = inRequest(async () => {
			recordAuthorizedProject({ projectId: "pA", organizationId: ORG_A });
			await aMayFinish;
			return resolveOrganizationId(undefined, {});
		});
		const requestB = inRequest(async () => {
			recordAuthorizedProject({ projectId: "pB", organizationId: ORG_B });
			const seen = resolveOrganizationId(null, {});
			releaseA();
			return seen;
		});
		await expect(Promise.all([requestA, requestB])).resolves.toEqual([
			ORG_A,
			ORG_B,
		]);
		expect(peekAuthorizedProject()).toBeNull();
	});
});

describe("resolveOrganizationId with a binding", () => {
	it("is unchanged when no project was authorized", () => {
		inRequest(() => {
			expect(resolveOrganizationId(ORG_B, {})).toBe(ORG_B);
			expect(
				resolveOrganizationId(null, { activeOrganizationId: ORG_A }),
			).toBe(undefined);
			expect(
				resolveOrganizationId(undefined, {
					activeOrganizationId: ORG_A,
				}),
			).toBe(ORG_A);
		});
	});

	it("refuses an input organization that differs from the authorized project's", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			expect(() => resolveOrganizationId(ORG_B, {})).toThrow(
				expect.objectContaining({
					code: "BAD_REQUEST",
					message: "organizationId does not match the project",
				}),
			);
		});
	});

	it("returns the project's organization for null, undefined or the same id", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			expect(
				resolveOrganizationId(null, { activeOrganizationId: ORG_B }),
			).toBe(ORG_A);
			expect(
				resolveOrganizationId(undefined, {
					activeOrganizationId: ORG_B,
				}),
			).toBe(ORG_A);
			expect(resolveOrganizationId(ORG_A, {})).toBe(ORG_A);
		});
	});

	it("refuses a project with no organization when one is consumed", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: null });
			expect(() => resolveOrganizationId(null, {})).toThrow(
				expect.objectContaining({
					code: "FORBIDDEN",
					message: "This project does not belong to an organization",
				}),
			);
		});
	});

	it("outranks the guest write organization", () => {
		mocks.effectiveWriteOrgId = ORG_B;
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			expect(resolveOrganizationId(null, {})).toBe(ORG_A);
		});
	});
});

describe("the other resolvers follow the same rule", () => {
	it("resolveOrganizationIdForCaller refuses a mismatch before the tie lookup", async () => {
		await inRequest(async () => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			await expect(
				resolveOrganizationIdForCaller(ORG_B, {}, USER),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.hasOrganizationTie).not.toHaveBeenCalled();
			await expect(
				resolveOrganizationIdForCaller(null, {}, USER),
			).resolves.toBe(ORG_A);
		});
	});

	it("authorizeInputOrganization (the target-organization mirror) checks membership in the PROJECT's organization", async () => {
		await inRequest(async () => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			const context = {
				user: { id: USER },
				session: { activeOrganizationId: ORG_B },
			};
			await expect(
				authorizeInputOrganization(
					Permissions.PROJECT_READ,
					ORG_B,
					context,
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();

			await expect(
				authorizeInputOrganization(
					Permissions.PROJECT_READ,
					null,
					context,
				),
			).resolves.toBe(ORG_A);
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				ORG_A,
				USER,
			);
		});
	});

	describe("authorizeInputOrganization and a soft-deleted target organization", () => {
		const context = {
			user: { id: USER },
			session: { activeOrganizationId: ORG_A },
		};

		it("refuses a member of the deleted organization with the deleted-organization code", async () => {
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "owner",
				organization: { id: ORG_B, deletedAt: new Date("2026-09-01") },
			});
			await expect(
				authorizeInputOrganization(
					Permissions.AGENT_READ,
					ORG_B,
					context,
				),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: "This organization has been deleted",
				data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
			});
			// Read from the one membership lookup, not a second query.
			expect(mocks.getOrganizationMembership).toHaveBeenCalledTimes(1);
		});

		it("still tells a non-member only that they are not a member", async () => {
			mocks.getOrganizationMembership.mockResolvedValue(null);
			const error = await authorizeInputOrganization(
				Permissions.AGENT_READ,
				ORG_B,
				context,
			).catch((e: unknown) => e);
			expect(error).toMatchObject({
				code: "FORBIDDEN",
				message: "You are not a member of this organization",
			});
			expect((error as { data?: unknown }).data).toBeUndefined();
		});

		it("lets a member of a live organization through", async () => {
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "owner",
				organization: { id: ORG_B, deletedAt: null },
			});
			await expect(
				authorizeInputOrganization(
					Permissions.AGENT_READ,
					ORG_B,
					context,
				),
			).resolves.toBe(ORG_B);
		});
	});

	it("resolveSourceCredentialOrganizationId keeps the pre-binding answer but refuses a mismatch", () => {
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			expect(
				resolveSourceCredentialOrganizationId(null, {
					activeOrganizationId: ORG_A,
				}),
			).toBeUndefined();
			expect(
				resolveSourceCredentialOrganizationId(undefined, {
					activeOrganizationId: ORG_B,
				}),
			).toBe(ORG_B);
			expect(() =>
				resolveSourceCredentialOrganizationId(ORG_B, {}),
			).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
		});
	});

	it("error and activity audit rows go to the authorized project's organization", () => {
		expect(auditOrganizationId(ORG_B, ORG_A)).toBe(ORG_B);
		inRequest(() => {
			recordAuthorizedProject({ projectId: "p", organizationId: ORG_A });
			expect(auditOrganizationId(ORG_B, ORG_B)).toBe(ORG_A);
		});
	});
});

describe("assertProjectPermission records the binding", () => {
	it.each([
		["the owner path", access("owner", null), null],
		[
			"the active ProjectMember path",
			access("project-member", ORG_A),
			ORG_A,
		],
		["the organization-role path", access("org", ORG_A), ORG_A],
	])("on %s", async (_label, effective, organizationId) => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(effective);
		await inRequest(async () => {
			const authorized = await assertProjectPermission(
				"p",
				USER,
				Permissions.PROJECT_READ,
			);
			expect(authorized).toEqual({ projectId: "p", organizationId });
			expect(Object.isFrozen(authorized)).toBe(true);
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p",
				organizationId,
			});
		});
	});

	it("still returns the binding outside a request, where there is no store", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			access("org", ORG_A),
		);
		await expect(
			assertProjectPermission("p", USER, Permissions.PROJECT_READ),
		).resolves.toEqual({ projectId: "p", organizationId: ORG_A });
	});

	it("refuses a project whose organization is deleted", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			access("org", ORG_A, { organizationDeleted: true }),
		);
		await inRequest(async () => {
			await expect(
				assertProjectPermission("p", USER, Permissions.PROJECT_READ),
			).rejects.toMatchObject({
				code: "FORBIDDEN",
				data: { errorCode: DELETED_ORGANIZATION_ERROR_CODE },
			});
			expect(peekAuthorizedProject()).toBeNull();
		});
	});

	it("answers NOT_FOUND before the deleted-organization refusal for an unrelated caller", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			access("none", ORG_A, { organizationDeleted: true }),
		);
		await expect(
			assertProjectPermission("p", USER, Permissions.PROJECT_READ),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(null);
		await expect(
			assertProjectPermission("p", USER, Permissions.PROJECT_READ),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("is idempotent when the same project is checked twice", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			access("project-member", ORG_A),
		);
		await inRequest(async () => {
			await assertProjectPermission("p", USER, Permissions.PROJECT_READ);
			await assertProjectPermission("p", USER, Permissions.PROJECT_READ);
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p",
				organizationId: ORG_A,
			});
		});
	});

	it("refuses a second project in another organization BEFORE the guest carve-out is granted", async () => {
		await inRequest(async () => {
			mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
				access("org", ORG_A),
			);
			await assertProjectPermission("p1", USER, Permissions.PROJECT_READ);

			mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
				access("project-member", ORG_B),
			);
			await expect(
				assertProjectPermission("p2", USER, Permissions.PROJECT_READ),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.grantProjectAccess).not.toHaveBeenCalled();
			expect(peekAuthorizedProject()).toEqual({
				projectId: "p1",
				organizationId: ORG_A,
			});
		});
	});

	it("records nothing when the role lacks the permission", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
			access("org", ORG_A, { permissions: [] }),
		);
		await inRequest(async () => {
			await expect(
				assertProjectPermission("p", USER, Permissions.PROJECT_UPDATE),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(peekAuthorizedProject()).toBeNull();
		});
	});
});

describe("through the real procedure chain", () => {
	// The weave refine and create-plan procedures use the PLAIN protected
	// builder with project permission middleware; there is no tenant context
	// there, so the holder must come from the root chain.
	const probe = protectedProcedure
		.use(requireProjectPermission(Permissions.PROJECT_READ))
		.input(
			z.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(({ input, context }) =>
			resolveOrganizationId(input.organizationId, context.session),
		);

	const invoke = (input: {
		projectId: string;
		organizationId?: string | null;
	}) => call(probe, input, { context: { headers: new Headers() } });

	beforeEach(() => {
		mocks.resolveEffectiveProjectPermissions.mockImplementation(
			async (projectId: string) =>
				access("org", projectId === "project-b" ? ORG_B : ORG_A),
		);
	});

	it("gives every builder a holder, public included", async () => {
		const holderProbe = os
			.$context<{ headers: Headers }>()
			.handler(() => hasProjectBindingHolder());
		await expect(
			call(holderProbe, undefined, {
				context: { headers: new Headers() },
			}),
		).resolves.toBe(false);
		await expect(
			call(
				publicProcedure.handler(() => hasProjectBindingHolder()),
				undefined,
				{ context: { headers: new Headers() } },
			),
		).resolves.toBe(true);
		await expect(
			call(
				protectedProcedure.handler(() => hasProjectBindingHolder()),
				undefined,
				{ context: { headers: new Headers() } },
			),
		).resolves.toBe(true);
	});

	it("refuses another organization named with a reachable project", async () => {
		await expect(
			invoke({ projectId: "project-a", organizationId: ORG_B }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("resolves the project's organization when none is named", async () => {
		await expect(
			invoke({ projectId: "project-a", organizationId: null }),
		).resolves.toBe(ORG_A);
		await expect(invoke({ projectId: "project-a" })).resolves.toBe(ORG_A);
	});

	describe("requireProjectPermission refuses a mismatched input organization before the handler runs", () => {
		// A handler that writes before it resolves would otherwise have
		// written by the time the resolver throws. The spy stands in for that
		// body: it must not run at all on a mismatch.
		const body = vi.fn(() => "ran");
		const gated = protectedProcedure
			.use(requireProjectPermission(Permissions.PROJECT_READ))
			.input(
				z.object({
					projectId: z.string(),
					organizationId: z.string().nullable().optional(),
				}),
			)
			.handler(body);
		const run = (input: {
			projectId: string;
			organizationId?: string | null;
		}) => call(gated, input, { context: { headers: new Headers() } });

		it("refuses another organization without entering the handler", async () => {
			await expect(
				run({ projectId: "project-a", organizationId: ORG_B }),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: "organizationId does not match the project",
			});
			expect(body).not.toHaveBeenCalled();
		});

		it.each([
			["null", null],
			["omitted", undefined],
			["the project's own", ORG_A],
		])(
			"passes an input organization that is %s",
			async (_label, organizationId) => {
				body.mockClear();
				await expect(
					run({ projectId: "project-a", organizationId }),
				).resolves.toBe("ran");
				expect(body).toHaveBeenCalledTimes(1);
			},
		);

		it("refuses a named organization for a project with none, before the handler", async () => {
			body.mockClear();
			mocks.resolveEffectiveProjectPermissions.mockResolvedValue(
				access("owner", null),
			);
			await expect(
				run({ projectId: "project-a", organizationId: ORG_A }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(body).not.toHaveBeenCalled();
		});
	});

	it("does not leak one call's binding into the next or a concurrent one", async () => {
		await expect(
			Promise.all([
				invoke({ projectId: "project-a" }),
				invoke({ projectId: "project-b" }),
				invoke({ projectId: "project-a", organizationId: ORG_A }),
			]),
		).resolves.toEqual([ORG_A, ORG_B, ORG_A]);
	});
});
