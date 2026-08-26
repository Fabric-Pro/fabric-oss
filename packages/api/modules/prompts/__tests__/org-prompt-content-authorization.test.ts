/**
 * Who may put ORGANIZATION-scoped prompt content into an organization.
 *
 * The tier gates on card 2068 cover which prompt an organization *points at*:
 * a binding at ORG scope demands an org admin, and so does approving a
 * nomination. This file covers the other half — the content behind the
 * pointer — where `create`, `update` and `delete` each stated the rule
 * explicitly ("Only organization admins can create organization prompts")
 * and `fork` reached the same end gated only by PROMPT_UPDATE, which
 * MEMBER_ORG_PERMISSIONS grants to every member.
 *
 * A member forking a system prompt to ORG scope could not make it anyone's
 * default — that still needs an admin — but it did put organization-owned
 * content in the organization's library through the one door left unlocked.
 * That was a difference between two paths to one outcome rather than a
 * decision anybody took, which is why the fix copies `create`'s gate rather
 * than inventing a weaker one for this path.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/org-prompt-content-authorization.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	forkPrompt,
	getPromptById,
	updatePrompt,
	verifyOrganizationMembership,
} = vi.hoisted(() => ({
	forkPrompt: vi.fn(),
	getPromptById: vi.fn(),
	updatePrompt: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({ forkPrompt, getPromptById, updatePrompt }));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

vi.mock("../lib/assert-valid-template", () => ({
	assertValidTemplate: vi.fn(),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	resolveOrganizationId: (input: string | null | undefined) => input ?? null,
	// Permissive builder: each link returns itself, so the chain works whatever
	// combination of route/input/output a given procedure happens to use.
	tenantProtectedProcedure: (() => {
		const link: Record<string, unknown> = {};
		for (const key of ["use", "route", "input", "output"]) {
			link[key] = () => link;
		}
		link.handler = (fn: unknown) => fn;
		return link;
	})(),
}));

import { forkProcedures } from "../procedures/fork";
import { updateProcedure } from "../procedures/update";

const asMember = { id: "member-1", role: null };

const callUpdate = () =>
	(updateProcedure as unknown as (a: unknown) => Promise<unknown>)({
		input: { id: "prompt-org-1", name: "Rewritten by a member" },
		context: { user: asMember, session: {} },
	});

const callFork = () =>
	(forkProcedures.fork as unknown as (a: unknown) => Promise<unknown>)({
		input: {
			sourcePromptId: "prompt-system-1",
			targetScope: "ORG",
			organizationId: "org-1",
		},
		context: { user: asMember, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
	getPromptById.mockResolvedValue({
		id: "prompt-org-1",
		scope: "ORG",
		organizationId: "org-1",
		userId: null,
		name: "The organization's default",
	});
	updatePrompt.mockResolvedValue({ id: "prompt-org-1" });
	forkPrompt.mockResolvedValue({ id: "prompt-forked-1", scope: "ORG" });
	// A plain member: a real membership row, without admin or owner.
	verifyOrganizationMembership.mockResolvedValue({
		organization: { id: "org-1" },
		role: "member",
	});
});

describe("editing an organization's prompt", () => {
	it("refuses a plain member", async () => {
		await expect(callUpdate()).rejects.toThrow(
			/Only organization admins can update organization prompts/i,
		);
		expect(updatePrompt).not.toHaveBeenCalled();
	});

	it("allows an org admin", async () => {
		verifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "admin",
		});

		await callUpdate();

		expect(updatePrompt).toHaveBeenCalled();
	});
});

describe("forking a system prompt to organization scope", () => {
	it("refuses a plain member, the same as creating one outright", async () => {
		// `create` already refuses this exact caller. Reaching ORG scope by
		// copying a system prompt instead of authoring one is the same act with
		// the same blast radius: organization-owned content everyone can see.
		await expect(callFork()).rejects.toThrow(
			/Only organization admins can fork a prompt to organization scope/i,
		);
		expect(forkPrompt).not.toHaveBeenCalled();
	});

	it("allows an org admin", async () => {
		verifyOrganizationMembership.mockResolvedValue({
			organization: { id: "org-1" },
			role: "owner",
		});

		await callFork();

		expect(forkPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-1",
			}),
		);
	});

	it("still lets any member fork to their own personal scope", async () => {
		// The personal path is the whole point of forking and is nobody else's
		// business — it must not be caught by the organization gate.
		await (
			forkProcedures.fork as unknown as (a: unknown) => Promise<unknown>
		)({
			input: {
				sourcePromptId: "prompt-system-1",
				targetScope: "USER",
				organizationId: "org-1",
			},
			context: { user: asMember, session: {} },
		});

		expect(forkPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "USER",
				userId: "member-1",
			}),
		);
	});
});
