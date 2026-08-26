/**
 * Which scope the Fork button asks for.
 *
 * The server gates an ORG fork on org admin, because it publishes into the
 * organization's library. Before that gate existed the UI sent ORG whenever an
 * organization was active, so adding the gate alone would have made Fork fail
 * on every member's click — a security fix turning a working button into a
 * dead one.
 *
 * These pin both directions, since each fails silently: too permissive and
 * members get a refusal, too strict and an admin quietly gets a personal copy
 * where they meant to publish for the organization.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/ForkScope.test.ts
 */

import { forkTarget, isProposalCandidate } from "@saas/prompts/lib/fork-scope";
import { describe, expect, it } from "vitest";

describe("the scope a fork asks for", () => {
	it("publishes to the organization for an org admin", () => {
		expect(
			forkTarget({ organizationId: "org-1", isOrganizationAdmin: true }),
		).toEqual({ targetScope: "ORG", organizationId: "org-1" });
	});

	it("gives a plain member their own copy rather than a refusal", () => {
		expect(
			forkTarget({ organizationId: "org-1", isOrganizationAdmin: false }),
		).toEqual({ targetScope: "USER", organizationId: undefined });
	});

	it("stamps no organization on a personal fork", () => {
		// Sending an organizationId alongside USER scope would attribute a
		// personal prompt to the organization the person happened to be in.
		const target = forkTarget({
			organizationId: "org-1",
			isOrganizationAdmin: false,
		});

		expect(target.organizationId).toBeUndefined();
	});

	it("forks personally outside any organization", () => {
		expect(
			forkTarget({ organizationId: null, isOrganizationAdmin: false }),
		).toEqual({ targetScope: "USER", organizationId: undefined });
	});

	it("does not promote a platform admin's personal context to an org fork", () => {
		// isOrganizationAdmin can be true with no active organization; without
		// an organization there is nothing to publish into.
		expect(
			forkTarget({
				organizationId: undefined,
				isOrganizationAdmin: true,
			}),
		).toEqual({ targetScope: "USER", organizationId: undefined });
	});
});

describe("the Propose Change candidate banner", () => {
	it("shows for the viewer's own personal copy when the flag is set", () => {
		expect(
			isProposalCandidate({
				promptScope: "USER",
				promptUserId: "me",
				viewerId: "me",
				proposeChangeParam: true,
			}),
		).toBe(true);
	});

	it("never shows on someone else's copy", () => {
		expect(
			isProposalCandidate({
				promptScope: "USER",
				promptUserId: "someone-else",
				viewerId: "me",
				proposeChangeParam: true,
			}),
		).toBe(false);
	});

	it("never shows on an org or system prompt, whatever the flag", () => {
		for (const scope of ["ORG", "SYSTEM"]) {
			expect(
				isProposalCandidate({
					promptScope: scope,
					promptUserId: null,
					viewerId: "me",
					proposeChangeParam: true,
				}),
			).toBe(false);
		}
	});

	it("does not show without the Propose Change flag", () => {
		expect(
			isProposalCandidate({
				promptScope: "USER",
				promptUserId: "me",
				viewerId: "me",
				proposeChangeParam: false,
			}),
		).toBe(false);
	});
});
