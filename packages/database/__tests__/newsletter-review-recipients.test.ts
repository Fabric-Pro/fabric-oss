/**
 * Coverage for the shared release-notes review recipient rule (Fizzy #2172).
 *
 * The decision is a pure function over rows the caller already loaded, so the
 * cases that actually distinguish the authorization precedence are a plain
 * table with no database and no mocking. The async wrapper around it only adds
 * queries.
 *
 * The precedence being reproduced (see `resolveEffectiveProjectPermissions` in
 * @repo/api, which cannot be imported here — the dependency runs the other way):
 *   A. personal-project owner → OWNER
 *   C. an ACTIVE (accepted, unexpired) ProjectMember row is authoritative; its
 *      role decides and the org role is NOT consulted
 *   B. otherwise the host-org role decides
 *
 * The trap is C's negative half: an unaccepted or expired row is not active, so
 * it is not authoritative either, and such a user still reaches B.
 */

import { describe, expect, it } from "vitest";
import { selectReviewRecipientIds } from "../prisma/queries/newsletter-review-recipients";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const PAST = new Date("2026-08-01T12:00:00.000Z");
const FUTURE = new Date("2026-09-01T12:00:00.000Z");

const orgProject = { organizationId: "org-1", userId: "creator-1" };
const personalProject = { organizationId: null, userId: "owner-1" };

function select(input: {
	project?: { organizationId: string | null; userId: string | null };
	members?: Array<{
		userId: string;
		role: string;
		acceptedAt: Date | null;
		expiresAt: Date | null;
	}>;
	orgMembers?: Array<{ userId: string; role: string }>;
}) {
	return selectReviewRecipientIds({
		project: input.project ?? orgProject,
		members: input.members ?? [],
		orgMembers: input.orgMembers ?? [],
		now: NOW,
	});
}

const accepted = (userId: string, role: string) => ({
	userId,
	role,
	acceptedAt: PAST,
	expiresAt: null,
});

describe("selectReviewRecipientIds — project-member path (C)", () => {
	it("includes an active project admin", () => {
		expect(select({ members: [accepted("u1", "PROJECT_ADMIN")] })).toEqual([
			"u1",
		]);
	});

	it("includes an active project owner", () => {
		expect(select({ members: [accepted("u1", "OWNER")] })).toEqual(["u1"]);
	});

	it("excludes an active member whose project role cannot edit settings", () => {
		expect(select({ members: [accepted("u1", "VIEWER")] })).toEqual([]);
	});

	it("excludes an active non-editing member EVEN when they are an org admin", () => {
		// Path C is authoritative: the org role must not rescue a role the
		// project deliberately narrowed. This is the case a naive
		// "union of both roles" implementation gets wrong.
		expect(
			select({
				members: [accepted("u1", "VIEWER")],
				orgMembers: [{ userId: "u1", role: "admin" }],
			}),
		).toEqual([]);
	});
});

describe("selectReviewRecipientIds — org-role fallback (B)", () => {
	it("includes an org owner with no project row", () => {
		expect(
			select({ orgMembers: [{ userId: "u1", role: "owner" }] }),
		).toEqual(["u1"]);
	});

	it("includes an org admin with no project row", () => {
		expect(
			select({ orgMembers: [{ userId: "u1", role: "admin" }] }),
		).toEqual(["u1"]);
	});

	it("excludes a plain org member", () => {
		expect(
			select({ orgMembers: [{ userId: "u1", role: "member" }] }),
		).toEqual([]);
	});

	it("includes an org admin whose project row is EXPIRED", () => {
		// An expired row is not active, so it is not authoritative — the live
		// resolver falls through to the org role and this user can approve.
		expect(
			select({
				members: [
					{
						userId: "u1",
						role: "VIEWER",
						acceptedAt: PAST,
						expiresAt: PAST,
					},
				],
				orgMembers: [{ userId: "u1", role: "admin" }],
			}),
		).toEqual(["u1"]);
	});

	it("includes an org admin whose project row is UNACCEPTED", () => {
		expect(
			select({
				members: [
					{
						userId: "u1",
						role: "VIEWER",
						acceptedAt: null,
						expiresAt: null,
					},
				],
				orgMembers: [{ userId: "u1", role: "admin" }],
			}),
		).toEqual(["u1"]);
	});

	it("treats a future expiry as still active, so path C keeps deciding", () => {
		expect(
			select({
				members: [
					{
						userId: "u1",
						role: "VIEWER",
						acceptedAt: PAST,
						expiresAt: FUTURE,
					},
				],
				orgMembers: [{ userId: "u1", role: "admin" }],
			}),
		).toEqual([]);
	});
});

describe("selectReviewRecipientIds — personal projects (A)", () => {
	it("includes the owner of a personal project", () => {
		expect(select({ project: personalProject })).toEqual(["owner-1"]);
	});

	it("ignores org members for a personal project", () => {
		expect(
			select({
				project: personalProject,
				orgMembers: [{ userId: "u1", role: "owner" }],
			}),
		).toEqual(["owner-1"]);
	});

	it("does not include the creator of an ORG project by creation alone", () => {
		// Creating a project grants nothing on its own. Under the live rule the
		// creator needs an active project role or an elevated org role, and the
		// previous recipient query notified them regardless — telling someone
		// about a review they would be refused.
		expect(
			select({
				project: orgProject,
				orgMembers: [{ userId: "creator-1", role: "member" }],
			}),
		).toEqual([]);
	});
});

describe("selectReviewRecipientIds — shape", () => {
	it("deduplicates and returns a stable order", () => {
		const ids = select({
			members: [accepted("u2", "PROJECT_ADMIN")],
			orgMembers: [
				{ userId: "u1", role: "owner" },
				{ userId: "u2", role: "owner" },
			],
		});
		expect(ids).toEqual(["u2", "u1"]);
	});

	it("returns an empty list when nobody qualifies", () => {
		expect(select({})).toEqual([]);
	});

	it("does not consult the slug — a missing one is the email's problem", () => {
		// The resolver reports organizationSlug and never enforces it. Enforcing
		// here would take the in-app notification away from a slugless
		// organization too, and that channel is unaffected: its link is
		// context-relative and interpolates no slug.
		expect(
			select({ orgMembers: [{ userId: "u1", role: "owner" }] }),
		).toEqual(["u1"]);
	});
});
