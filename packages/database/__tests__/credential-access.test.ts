import { describe, expect, it } from "vitest";
import {
	type CredentialAccessRow,
	type CredentialActor,
	canManageCredential,
	canSeeCredential,
	canUseCredential,
} from "../prisma/queries/lib/credential-access";

const member: CredentialActor = {
	userId: "user-1",
	organizationId: "org-1",
	canManageOrganizationIntegrations: false,
};
const admin: CredentialActor = {
	...member,
	userId: "admin-1",
	canManageOrganizationIntegrations: true,
};

const own: CredentialAccessRow = {
	organizationId: "org-1",
	userId: "user-1",
	sharing: "PRIVATE",
	status: "ACTIVE",
};
const othersPrivate: CredentialAccessRow = { ...own, userId: "user-2" };
const othersShared: CredentialAccessRow = {
	...othersPrivate,
	sharing: "ORGANIZATION",
};
const orgOwned: CredentialAccessRow = {
	...own,
	userId: null,
	sharing: "ORGANIZATION",
};

describe("credential access", () => {
	it("a member sees, uses and manages only their own private credential", () => {
		expect(canSeeCredential(own, member)).toBe(true);
		expect(canManageCredential(own, member)).toBe(true);
		expect(canSeeCredential(othersPrivate, member)).toBe(false);
		expect(canUseCredential(othersPrivate, member)).toBe(false);
	});

	it("an admin role does not reach another member's private credential", () => {
		expect(canSeeCredential(othersPrivate, admin)).toBe(false);
		expect(canManageCredential(othersPrivate, admin)).toBe(false);
	});

	it("a shared credential is usable by members but managed only by its owner", () => {
		expect(canUseCredential(othersShared, member)).toBe(true);
		expect(canManageCredential(othersShared, member)).toBe(false);
		expect(canManageCredential(othersShared, admin)).toBe(false);
	});

	it("an organization credential is usable by members and managed by integration managers", () => {
		expect(canUseCredential(orgOwned, member)).toBe(true);
		expect(canManageCredential(orgOwned, member)).toBe(false);
		expect(canManageCredential(orgOwned, admin)).toBe(true);
	});

	it("nothing crosses organizations", () => {
		const elsewhere = { ...member, organizationId: "org-2" };
		for (const row of [own, othersShared, orgOwned]) {
			expect(canSeeCredential(row, elsewhere)).toBe(false);
			expect(canUseCredential(row, elsewhere)).toBe(false);
			expect(
				canManageCredential(row, { ...admin, organizationId: "org-2" }),
			).toBe(false);
		}
	});

	it("a revoked credential stays visible for cleanup but is never usable", () => {
		const revoked = { ...own, status: "REVOKED" as const };
		expect(canSeeCredential(revoked, member)).toBe(true);
		expect(canUseCredential(revoked, member)).toBe(false);
		expect(canManageCredential(revoked, member)).toBe(true);
	});
});
