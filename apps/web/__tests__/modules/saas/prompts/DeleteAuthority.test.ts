/**
 * Who is offered Delete on a prompt (Fizzy #2328, R1/R2/R4).
 *
 * Three listing surfaces each decided this for themselves with
 * `prompt.scope !== "SYSTEM"`, so a platform administrator the API would have
 * obeyed was never shown the control. `canDeletePrompt` replaces all three.
 *
 * These rows are a truth table read off the server's own branches in
 * `packages/api/modules/prompts/lib/scope-authority.ts` — shared by the delete
 * procedure and the platform-wide impact read — plus the
 * `requirePermission(PROMPT_DELETE)` middleware in front of it. They exist to
 * pin the direction of the error: the predicate must never offer a control the
 * server would refuse (KTD2). Three rows carry more than that —
 *
 *   - a global admin who is an ordinary MEMBER here is refused. This is exactly
 *     what `isOrganizationAdmin` would have wrongly allowed, which is why the
 *     predicate does not use it;
 *   - a global admin with NO active organization is refused, where the server
 *     would allow it. That divergence is intentional and documented at the
 *     branch; the row is here so nobody "fixes" the predicate toward the server;
 *   - an ordinary MEMBER is refused their OWN prompt inside an organization.
 *     That row was pinned the other way when this file first landed, which is
 *     the mistake the middleware makes easy to make: `scope-authority.ts` asks
 *     only "is it yours?", and reading it alone misses that
 *     `requirePermission(PROMPT_DELETE)` has already refused a member before
 *     that question is reached.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/DeleteAuthority.test.ts
 */

import { canDeletePrompt } from "@saas/prompts/lib/delete-authority";
import { describe, expect, it } from "vitest";

const systemPrompt = {
	scope: "SYSTEM",
	organizationId: null,
	userId: null,
};

const orgPrompt = {
	scope: "ORG",
	organizationId: "org-1",
	userId: null,
};

const myPrompt = {
	scope: "USER",
	organizationId: null,
	userId: "me",
};

/** A viewer inside org-1, with the roles varied per row. */
function viewerIn(
	organizationRole: string | null,
	globalRole: string | null = null,
) {
	return {
		userId: "me",
		globalRole,
		organizationId: organizationRole === null ? null : "org-1",
		organizationRole,
	};
}

describe("deleting a SYSTEM prompt", () => {
	it("is offered to a global admin who is an organization admin", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("admin", "admin"),
			}),
		).toBe(true);
	});

	it("is offered to a global admin who is an organization owner", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("owner", "admin"),
			}),
		).toBe(true);
	});

	it("is withheld from a global admin who is only an ordinary member", () => {
		// The case `isOrganizationAdmin` returns true for — it ignores
		// membership entirely for a global admin. The server's
		// requirePermission(PROMPT_DELETE) refuses this click, so the control
		// must not appear.
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("member", "admin"),
			}),
		).toBe(false);
	});

	it("is withheld from a global admin who is only a viewer", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("viewer", "admin"),
			}),
		).toBe(false);
	});

	it("is withheld from an organization admin without the global role", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("admin", null),
			}),
		).toBe(false);
	});

	it("is withheld from a global admin with no active organization", () => {
		// INTENTIONAL DIVERGENCE from the server, not a gap. The permission
		// middleware returns early with no organization context and would allow
		// this; the client refuses, per
		// docs/adr/018-organization-is-the-only-tenant-context.md, because an
		// unresolved organization is a fail-closed default rather than a
		// context to run a platform-wide destructive action from. Do not
		// "align" this with the server.
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: {
					userId: "me",
					globalRole: "admin",
					organizationId: null,
					organizationRole: null,
				},
			}),
		).toBe(false);
	});

	it("is withheld from an ordinary member with no global role", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: viewerIn("member", null),
			}),
		).toBe(false);
	});
});

describe("deleting an ORG prompt", () => {
	it("is offered to an admin of the owning organization", () => {
		expect(
			canDeletePrompt({
				prompt: orgPrompt,
				viewer: viewerIn("admin"),
			}),
		).toBe(true);
	});

	it("is offered to an owner of the owning organization", () => {
		expect(
			canDeletePrompt({
				prompt: orgPrompt,
				viewer: viewerIn("owner"),
			}),
		).toBe(true);
	});

	it("is withheld from an ordinary member of the owning organization", () => {
		expect(
			canDeletePrompt({
				prompt: orgPrompt,
				viewer: viewerIn("member"),
			}),
		).toBe(false);
	});

	it("is withheld from an admin of a different organization", () => {
		// The client only knows the viewer's role in the ACTIVE organization,
		// so being an admin somewhere else says nothing about this prompt.
		expect(
			canDeletePrompt({
				prompt: orgPrompt,
				viewer: {
					userId: "me",
					globalRole: null,
					organizationId: "org-2",
					organizationRole: "admin",
				},
			}),
		).toBe(false);
	});

	it("is withheld when the prompt carries no organization", () => {
		// The server treats this as a server error rather than a permission.
		expect(
			canDeletePrompt({
				prompt: { scope: "ORG", organizationId: null, userId: null },
				viewer: viewerIn("admin"),
			}),
		).toBe(false);
	});
});

describe("deleting a USER prompt", () => {
	it("is offered to its owner when they may delete prompts here", () => {
		expect(
			canDeletePrompt({
				prompt: myPrompt,
				viewer: viewerIn("admin"),
			}),
		).toBe(true);

		expect(
			canDeletePrompt({
				prompt: myPrompt,
				viewer: viewerIn("owner"),
			}),
		).toBe(true);
	});

	it("is withheld from its owner when they are an ordinary member here", () => {
		// Not a regression, and not a permission this ticket removed — the
		// control never worked. `requirePermission(PROMPT_DELETE)` runs in
		// front of the delete handler and is evaluated whenever the tenant
		// context is an organization, which every listing surface is;
		// `MEMBER_ORG_PERMISSIONS` in `packages/permissions/lib/roles.ts` does
		// not carry `PROMPT_DELETE` (it first appears in
		// `ADMIN_ORG_PERMISSIONS`). A member offered Delete on their own prompt
		// got FORBIDDEN from the server, so the affordance was MORE permissive
		// than the server — the one direction this file exists to forbid.
		expect(
			canDeletePrompt({
				prompt: myPrompt,
				viewer: viewerIn("member"),
			}),
		).toBe(false);
	});

	it("is withheld from its owner when they are only a viewer here", () => {
		expect(
			canDeletePrompt({
				prompt: myPrompt,
				viewer: viewerIn("viewer"),
			}),
		).toBe(false);
	});

	it("is offered to its owner outside any organization", () => {
		// The one place the organization role is not asked, because there is
		// nothing to ask: with no tenant context the middleware returns early
		// and the server allows the deletion. Unlike the SYSTEM branch, this
		// costs nobody else anything — it is the owner's own prompt.
		expect(
			canDeletePrompt({
				prompt: myPrompt,
				viewer: {
					userId: "me",
					globalRole: null,
					organizationId: null,
					organizationRole: null,
				},
			}),
		).toBe(true);
	});

	it("is withheld from anybody else, organization admin or not", () => {
		const someoneElse = {
			userId: "someone-else",
			globalRole: "admin",
			organizationId: "org-1",
			organizationRole: "admin",
		};

		expect(canDeletePrompt({ prompt: myPrompt, viewer: someoneElse })).toBe(
			false,
		);
	});

	it("is withheld when the prompt has no owner recorded", () => {
		expect(
			canDeletePrompt({
				prompt: { scope: "USER", organizationId: null, userId: null },
				viewer: viewerIn("admin"),
			}),
		).toBe(false);
	});
});

describe("a viewer whose session has not resolved", () => {
	it("treats a missing global role as absent rather than throwing", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: {
					userId: "me",
					globalRole: undefined,
					organizationId: "org-1",
					organizationRole: "admin",
				},
			}),
		).toBe(false);
	});

	it("treats a null global role as absent rather than throwing", () => {
		expect(
			canDeletePrompt({
				prompt: systemPrompt,
				viewer: {
					userId: "me",
					globalRole: null,
					organizationId: "org-1",
					organizationRole: "admin",
				},
			}),
		).toBe(false);
	});

	it("offers nothing at all while every field is still unknown", () => {
		const unknown = {
			userId: undefined,
			globalRole: undefined,
			organizationId: undefined,
			organizationRole: undefined,
		};

		for (const prompt of [systemPrompt, orgPrompt, myPrompt]) {
			expect(canDeletePrompt({ prompt, viewer: unknown })).toBe(false);
		}
	});
});

describe("a scope the predicate does not recognise", () => {
	it("is refused, where the server's chain would fall through and delete", () => {
		expect(
			canDeletePrompt({
				prompt: {
					scope: "TEAM",
					organizationId: "org-1",
					userId: "me",
				},
				viewer: viewerIn("owner", "admin"),
			}),
		).toBe(false);
	});
});
