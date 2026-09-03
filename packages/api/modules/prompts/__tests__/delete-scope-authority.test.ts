/**
 * The per-scope authority a prompt deletion requires (Fizzy #2328 — R1, R4).
 *
 * One rule, asked by two callers: the deletion in `procedures/delete.ts` and
 * the platform-wide impact read in `procedures/deletion-impact.ts`. The read is
 * un-scoped across every tenant and the only thing that makes it legitimate is
 * that its caller could carry out the deletion — so the two must never drift,
 * which is why the rule lives in one function and this suite tests that
 * function rather than either handler.
 *
 * The case this file exists for is the LAST one. `assertPromptDeleteAuthority`
 * signals refusal by throwing, so an if/return chain that runs off its end
 * authorizes: a scope no branch claims used to return normally, and the caller
 * read that as "allowed" and deleted. `apps/web`'s mirror of these branches
 * already refused an unrecognised scope, so the two disagreed in the one
 * direction that costs data — the affordance withheld, the server permissive.
 *
 * Run with:
 *   pnpm --filter api test modules/prompts/__tests__/delete-scope-authority.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifyOrganizationMembership } = vi.hoisted(() => ({
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

import { assertPromptDeleteAuthority } from "../lib/scope-authority";

const ADMIN = { id: "user-1", role: "admin" };
const MEMBER = { id: "user-1", role: "user" };

beforeEach(() => {
	vi.clearAllMocks();
	verifyOrganizationMembership.mockResolvedValue({ role: "admin" });
});

describe("assertPromptDeleteAuthority — a scope no branch claims", () => {
	// The whole point: not "it throws something", but that it does not RETURN.
	// Returning is this function's success signal.
	it("refuses instead of falling through to authorized", async () => {
		const verdict = await assertPromptDeleteAuthority(
			{ scope: "WORKSPACE", organizationId: null, userId: null },
			ADMIN,
		).then(
			() => "authorized",
			(error) => error,
		);

		expect(verdict).not.toBe("authorized");
		expect(verdict.code).toBe("FORBIDDEN");
	});

	// A global administrator is the most privileged caller there is, and the
	// unrecognised scope is still refused: the refusal is about there being no
	// rule to apply, not about who is asking.
	it("refuses a global administrator the same way", async () => {
		await expect(
			assertPromptDeleteAuthority(
				{ scope: "PROJECT", organizationId: "org-1", userId: null },
				ADMIN,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it.each(["", "system", "Org", "user", "UNKNOWN"])(
		"refuses the scope %o — including a mis-cased near-miss",
		async (scope) => {
			await expect(
				assertPromptDeleteAuthority(
					{ scope, organizationId: "org-1", userId: "user-1" },
					ADMIN,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		},
	);
});

describe("assertPromptDeleteAuthority — the three scopes that do have rules", () => {
	it("lets a global administrator delete a SYSTEM prompt", async () => {
		await expect(
			assertPromptDeleteAuthority(
				{ scope: "SYSTEM", organizationId: null, userId: null },
				ADMIN,
			),
		).resolves.toBeUndefined();
	});

	it("refuses a SYSTEM prompt to anyone else", async () => {
		await expect(
			assertPromptDeleteAuthority(
				{ scope: "SYSTEM", organizationId: null, userId: null },
				MEMBER,
			),
		).rejects.toThrow(/administrators/i);
	});

	it("lets an organization admin delete that organization's prompt", async () => {
		await expect(
			assertPromptDeleteAuthority(
				{ scope: "ORG", organizationId: "org-1", userId: null },
				MEMBER,
			),
		).resolves.toBeUndefined();

		// The PROMPT's organization, not the caller's active one — an ORG
		// prompt may belong to any organization the caller is a member of.
		expect(verifyOrganizationMembership).toHaveBeenCalledWith(
			"org-1",
			"user-1",
		);
	});

	it("refuses an ordinary member of the owning organization", async () => {
		verifyOrganizationMembership.mockResolvedValue({ role: "member" });

		await expect(
			assertPromptDeleteAuthority(
				{ scope: "ORG", organizationId: "org-1", userId: null },
				MEMBER,
			),
		).rejects.toThrow(/organization admins/i);
	});

	it("refuses a non-member of the owning organization", async () => {
		verifyOrganizationMembership.mockResolvedValue(null);

		await expect(
			assertPromptDeleteAuthority(
				{ scope: "ORG", organizationId: "org-other", userId: null },
				ADMIN,
			),
		).rejects.toThrow(/not a member/i);
	});

	it("lets the owner delete their own USER prompt, and nobody else", async () => {
		await expect(
			assertPromptDeleteAuthority(
				{ scope: "USER", organizationId: null, userId: "user-1" },
				MEMBER,
			),
		).resolves.toBeUndefined();

		await expect(
			assertPromptDeleteAuthority(
				{ scope: "USER", organizationId: null, userId: "user-2" },
				// A global administrator is not the owner. The SYSTEM branch's
				// privilege does not carry into somebody's personal prompt.
				ADMIN,
			),
		).rejects.toThrow(/your own prompts/i);
	});
});
