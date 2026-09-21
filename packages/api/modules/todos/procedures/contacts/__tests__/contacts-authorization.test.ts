/**
 * The contact register's authorization gate, run against the REAL
 * `requireInputOrgPermission` middleware (#2340).
 *
 * `contacts.test.ts` pins what each procedure DECLARES — the permission and
 * `requireOrganization: true` — because `.use()` is a no-op in the stubbed
 * procedure chain there. This file pins what that declaration DOES, driving the
 * real middleware with the same four permission keys.
 *
 * The register holds names and contact details of client-side staff across
 * every project in an organization, so three refusals matter more here than
 * almost anywhere else:
 *
 *  - A caller who NAMES an organization they have no tie to is refused. This is
 *    the whole reason the procedures use `requireInputOrgPermission` rather than
 *    `requirePermission`: the latter checks the caller's SESSION org role, so an
 *    admin of one tenant could pass another tenant's id and their own role would
 *    satisfy it.
 *  - A PROJECT-SCOPED GUEST is refused outright. Their invitation is to one
 *    project; this register spans all of them, and a guest holds no `Member`
 *    row for the middleware's membership lookup to find.
 *  - A caller sending `organizationId: null` is refused rather than waved
 *    through. Explicit null does not fall back to the session, so without
 *    `requireOrganization: true` it resolves to nothing and the role check never
 *    runs — a bypass, because a contact has no personal variant for that
 *    pass-through to be correct for.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/todos
 */

import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "../../../../../lib/missing-organization-context";

const mocks = vi.hoisted(() => ({
	getOrganizationMembership: vi.fn(),
	getTenantContext: vi.fn(() => ({ effectiveWriteOrgId: undefined })),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: vi.fn() },
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		projectMember: { findUnique: vi.fn() },
	},
	grantProjectAccess: vi.fn(),
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: mocks.getTenantContext,
}));

const { requireInputOrgPermission } = await import(
	"../../../../../orpc/middleware/require-permission"
);

const USER_ID = "user-1";
const SESSION_ORG = "org-acme";
const OTHER_ORG = "org-meridian";

/**
 * The gate each contact procedure declares. Kept in the same order and with
 * the same keys as the table in `contacts.test.ts`, which asserts these are
 * what the four files actually pass.
 */
const CONTACT_GATES = [
	["contacts.list", Permissions.ORG_MEMBERS_READ],
	["contacts.create", Permissions.ORG_MEMBERS_INVITE],
	["contacts.update", Permissions.ORG_MEMBERS_INVITE],
	["contacts.delete", Permissions.ORG_MEMBERS_REMOVE],
] as const;

/** The three that a plain `member` role must not be able to perform. */
const WRITE_GATES = CONTACT_GATES.filter(
	([procedure]) => procedure !== "contacts.list",
);

type Ctx = {
	user?: { id: string };
	session: { activeOrganizationId?: string | null };
	tenantContext?: {
		userId: string | null;
		type: "organization" | "personal" | "none";
		organizationId: string | null;
		allowedProjectIds?: string[];
	};
};

function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
	return {
		user: { id: USER_ID },
		session: { activeOrganizationId: SESSION_ORG },
		tenantContext: {
			userId: USER_ID,
			type: "organization",
			organizationId: SESSION_ORG,
		},
		...overrides,
	};
}

// oRPC returns the tagged middleware as a callable — invoke it directly with
// ({ context, next }, input). Mirrors `__tests__/require-input-org-permission.test.ts`.
async function invoke(mw: unknown, ctx: Ctx, input: unknown) {
	const next = vi.fn().mockResolvedValue({ output: "ok" });
	await (
		mw as (
			arg: { context: Ctx; next: typeof next },
			input: unknown,
		) => Promise<unknown>
	)({ context: ctx, next }, input);
	return next;
}

function gate(permission: string) {
	return requireInputOrgPermission(
		permission as (typeof Permissions)[keyof typeof Permissions],
		{ requireOrganization: true },
	);
}

beforeEach(() => {
	mocks.getOrganizationMembership.mockReset();
	mocks.getTenantContext.mockReset();
	mocks.getTenantContext.mockReturnValue({ effectiveWriteOrgId: undefined });
});

describe.each(CONTACT_GATES)("%s gate", (_procedure, permission) => {
	it("refuses a caller who names an organization they have no tie to", async () => {
		// The caller is a real admin — of their OWN organization. Naming
		// another tenant's id must not borrow that role.
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			invoke(gate(permission), makeCtx(), {
				organizationId: OTHER_ORG,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		// The lookup targets the INPUT organization, not the session's. If it
		// asked about the session org it would find a membership and let the
		// request through against the other tenant.
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			OTHER_ORG,
			USER_ID,
		);
	});

	it("refuses a project-scoped guest, who holds no organization membership", async () => {
		// A guest reaches project surfaces through `allowedProjectIds`. There
		// is no guest fallback in this middleware, and there must not be: the
		// register is not project-scoped, so an invitation to one project can
		// never be an argument for reading all of the organization's contacts.
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(
			invoke(
				gate(permission),
				makeCtx({
					session: { activeOrganizationId: null },
					tenantContext: {
						userId: USER_ID,
						type: "organization",
						organizationId: SESSION_ORG,
						allowedProjectIds: ["project-1"],
					},
				}),
				{ organizationId: SESSION_ORG },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses an explicit organizationId of null instead of passing through", async () => {
		const error = await invoke(gate(permission), makeCtx(), {
			organizationId: null,
		}).catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "FORBIDDEN",
			data: { errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE },
		});
		// Refused before any lookup: the point is that the role check cannot be
		// SKIPPED, so the request must not get as far as one.
		expect(mocks.getOrganizationMembership).not.toHaveBeenCalled();
	});

	it("admits an owner of the organization named in the input", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });

		const next = await invoke(gate(permission), makeCtx(), {
			organizationId: OTHER_ORG,
		});

		expect(next).toHaveBeenCalled();
	});
});

describe("role level", () => {
	it("lets a plain member READ the register", async () => {
		// The register is how a member knows who owes them a deliverable, so
		// reading it is not an administrative act.
		mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });

		const next = await invoke(
			gate(Permissions.ORG_MEMBERS_READ),
			makeCtx(),
			{ organizationId: SESSION_ORG },
		);

		expect(next).toHaveBeenCalled();
	});

	it.each(WRITE_GATES)(
		"refuses a plain member on %s",
		async (_procedure, permission) => {
			// Adding, editing or erasing a record about someone outside the
			// organization is the same kind of act as inviting or removing a
			// member, and sits at the same role.
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "member",
			});

			await expect(
				invoke(gate(permission), makeCtx(), {
					organizationId: SESSION_ORG,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);

	it("refuses a viewer on every write", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });

		for (const [, permission] of WRITE_GATES) {
			await expect(
				invoke(gate(permission), makeCtx(), {
					organizationId: SESSION_ORG,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
});
