/**
 * `findOwnPatCredentialForAccount` is the match a pasted GitHub token is
 * offered instead of a duplicate. It must answer only with the caller's own
 * non-revoked PAT for that account in that organization: a credential of
 * another organization or another member never matches. The where-clause is
 * pinned, and evaluated against rows that differ in exactly one field.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("../prisma/client", () => ({
	db: { credential: { findFirst: mocks.findFirst } },
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => value,
	decryptApiKey: (value: string) => value,
}));

import { findOwnPatCredentialForAccount } from "../prisma/queries/credential-store";

type Row = {
	id: string;
	organizationId: string;
	userId: string | null;
	provider: string;
	kind: string;
	externalAccountId: string | null;
	status: string;
};

const mine: Row = {
	id: "cred-mine",
	organizationId: "org-1",
	userId: "user-1",
	provider: "GITHUB",
	kind: "PAT",
	externalAccountId: "42",
	status: "ACTIVE",
};

/** The subset of Prisma's where semantics the query uses. */
function matches(where: Record<string, unknown>, row: Row): boolean {
	return Object.entries(where).every(([key, condition]) => {
		const value = row[key as keyof Row];
		if (
			condition &&
			typeof condition === "object" &&
			"not" in (condition as Record<string, unknown>)
		) {
			return value !== (condition as { not: unknown }).not;
		}
		return value === condition;
	});
}

const input = {
	organizationId: "org-1",
	userId: "user-1",
	provider: "GITHUB" as const,
	externalAccountId: "42",
};

describe("findOwnPatCredentialForAccount", () => {
	beforeEach(() => {
		mocks.findFirst.mockReset();
		mocks.findFirst.mockResolvedValue(null);
	});

	it("matches the caller's own non-revoked PAT for the account", async () => {
		await findOwnPatCredentialForAccount(input);
		const where = mocks.findFirst.mock.calls[0]?.[0]?.where;
		expect(where).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			provider: "GITHUB",
			kind: "PAT",
			externalAccountId: "42",
			status: { not: "REVOKED" },
		});
		expect(matches(where, mine)).toBe(true);
	});

	it.each([
		["another organization", { organizationId: "org-2" }],
		["another member", { userId: "user-2" }],
		["the organization", { userId: null }],
		["another account", { externalAccountId: "43" }],
		["an OAuth grant", { kind: "OAUTH" }],
		["a revoked credential", { status: "REVOKED" }],
		["another provider", { provider: "GITLAB" }],
	])("never matches %s", async (_name, change) => {
		await findOwnPatCredentialForAccount(input);
		const where = mocks.findFirst.mock.calls[0]?.[0]?.where;
		expect(matches(where, { ...mine, ...change })).toBe(false);
	});
});
