import { describe, expect, it } from "vitest";
import { selectPublishingRecipientIds } from "../../prisma/queries/projects/publishing-recipients";

const NOW = new Date("2026-08-12T00:00:00.000Z");
const ACTIVE = {
	acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
	expiresAt: null,
};

describe("selectPublishingRecipientIds", () => {
	it("notifies a personal-project active EDITOR — the case a copied newsletter helper drops", () => {
		// The newsletter resolver returns the owner and STOPS on a personal project. Nothing in the
		// schema forbids ProjectMember rows there, and the effective-permissions resolver's owner
		// check is a test on the CALLER, not a short-circuit for the whole project.
		const ids = selectPublishingRecipientIds({
			project: { organizationId: null, userId: "owner" },
			members: [{ userId: "editor", role: "EDITOR", ...ACTIVE }],
			orgMembers: [],
			now: NOW,
		});
		expect(ids.sort()).toEqual(["editor", "owner"]);
	});

	it("notifies an org member with no ProjectMember row at all", () => {
		const ids = selectPublishingRecipientIds({
			project: { organizationId: "org", userId: "creator" },
			members: [],
			orgMembers: [{ userId: "orgmember", role: "member" }],
			now: NOW,
		});
		expect(ids).toEqual(["orgmember"]);
	});

	it("does NOT notify an org admin whose active project role is VIEWER", () => {
		// An active ProjectMember row is AUTHORITATIVE — its role decides and the org role is not
		// consulted. A naive union with org roles gets this wrong in the dangerous direction.
		const ids = selectPublishingRecipientIds({
			project: { organizationId: "org", userId: "creator" },
			members: [{ userId: "u", role: "VIEWER", ...ACTIVE }],
			orgMembers: [{ userId: "u", role: "admin" }],
			now: NOW,
		});
		expect(ids).toEqual([]);
	});

	it("falls through to the org role when the project row is unaccepted or expired", () => {
		// The negative side of "active". An unaccepted or expired row is not authoritative, so the
		// user still reaches the org-role path — dropping them would silence an org admin whose
		// project invitation merely lapsed.
		const unaccepted = selectPublishingRecipientIds({
			project: { organizationId: "org", userId: "creator" },
			members: [
				{
					userId: "u",
					role: "VIEWER",
					acceptedAt: null,
					expiresAt: null,
				},
			],
			orgMembers: [{ userId: "u", role: "admin" }],
			now: NOW,
		});
		expect(unaccepted).toEqual(["u"]);

		const expired = selectPublishingRecipientIds({
			project: { organizationId: "org", userId: "creator" },
			members: [
				{
					userId: "u",
					role: "VIEWER",
					acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
					expiresAt: new Date("2026-02-01T00:00:00.000Z"),
				},
			],
			orgMembers: [{ userId: "u", role: "admin" }],
			now: NOW,
		});
		expect(expired).toEqual(["u"]);
	});

	it("applies PUBLISHING_TOPIC_CREATE per role, which is the only thing distinguishing it from READ", () => {
		const project = { organizationId: "org", userId: "creator" };
		const roleIsNotified = (role: string) =>
			selectPublishingRecipientIds({
				project,
				members: [{ userId: "u", role, ...ACTIVE }],
				orgMembers: [],
				now: NOW,
			}).includes("u");

		expect(roleIsNotified("VIEWER")).toBe(false);
		expect(roleIsNotified("COMMENTER")).toBe(false);
		expect(roleIsNotified("EDITOR")).toBe(true);
		expect(roleIsNotified("PROJECT_ADMIN")).toBe(true);
		expect(roleIsNotified("OWNER")).toBe(true);

		const orgRoleIsNotified = (role: string) =>
			selectPublishingRecipientIds({
				project,
				members: [],
				orgMembers: [{ userId: "u", role }],
				now: NOW,
			}).includes("u");

		expect(orgRoleIsNotified("viewer")).toBe(false);
		expect(orgRoleIsNotified("member")).toBe(true);
		expect(orgRoleIsNotified("admin")).toBe(true);
		expect(orgRoleIsNotified("owner")).toBe(true);
	});

	it("excludes a role neither permission map recognises, instead of adopting it", () => {
		// The role cases above are each clearly in or clearly out. This is the third kind: a role
		// string the map has never heard of — a value added to the Prisma enum but not yet to
		// roles.ts, or the right role in the wrong case (project roles are UPPERCASE, org roles
		// lowercase). Both resolvers answer with an EMPTY permission set, so stating who is INCLUDED
		// fails closed. A filter written as a negation ("everyone except VIEWER and COMMENTER")
		// would silently adopt every one of them.
		const project = { organizationId: "org", userId: "creator" };

		expect(
			selectPublishingRecipientIds({
				project,
				members: [{ userId: "u", role: "AUDITOR", ...ACTIVE }],
				orgMembers: [],
				now: NOW,
			}),
		).toEqual([]);

		expect(
			selectPublishingRecipientIds({
				project,
				members: [{ userId: "u", role: "editor", ...ACTIVE }],
				orgMembers: [],
				now: NOW,
			}),
		).toEqual([]);

		expect(
			selectPublishingRecipientIds({
				project,
				members: [],
				orgMembers: [{ userId: "u", role: "billing" }],
				now: NOW,
			}),
		).toEqual([]);

		expect(
			selectPublishingRecipientIds({
				project,
				members: [],
				orgMembers: [{ userId: "u", role: "MEMBER" }],
				now: NOW,
			}),
		).toEqual([]);
	});
});
