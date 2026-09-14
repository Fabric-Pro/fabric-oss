/**
 * Naming the organization on the confirmation page (Fizzy #2462).
 *
 * The page this feeds is the last screen before a tenant goes dark, and it used
 * to say only "this organization". Resolving the name is a UX fix; the tests
 * below are about the two ways resolving it could go wrong:
 *
 *  - it must not SPEND the token (the page renders for mail scanners);
 *  - it must not name the organization to anyone but the requester, or a
 *    leaked link becomes a tool for discovering what it points at.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const verification = {
	findFirst: vi.fn(),
	deleteMany: vi.fn(),
};
const organization = {
	findFirst: vi.fn(),
};

vi.mock("@repo/database", () => ({
	db: { verification, organization },
}));

const ORG_ID = "org-example";
const USER_ID = "user-example";
const TOKEN = "tok-example";

function tokenRow(payload: object, expiresInMs = 60_000) {
	return {
		value: JSON.stringify(payload),
		expiresAt: new Date(Date.now() + expiresInMs),
	};
}

async function load() {
	return await import("../server-fetch");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("fetchOrganizationNameForDeletionToken", () => {
	it("names the organization for the person the token was minted for", async () => {
		const { fetchOrganizationNameForDeletionToken } = await load();
		verification.findFirst.mockResolvedValue(
			tokenRow({ organizationId: ORG_ID, userId: USER_ID }),
		);
		organization.findFirst.mockResolvedValue({ name: "Example Org" });

		expect(
			await fetchOrganizationNameForDeletionToken({
				token: TOKEN,
				userId: USER_ID,
			}),
		).toBe("Example Org");

		// It looked up the organization the TOKEN names, never one the caller
		// supplied — the token is the only thing that decides which tenant is
		// in play.
		expect(organization.findFirst.mock.calls[0]?.[0]?.where).toEqual({
			id: ORG_ID,
		});
	});

	it("refuses to name it to a different account", async () => {
		const { fetchOrganizationNameForDeletionToken } = await load();
		verification.findFirst.mockResolvedValue(
			tokenRow({ organizationId: ORG_ID, userId: USER_ID }),
		);
		organization.findFirst.mockResolvedValue({ name: "Example Org" });

		expect(
			await fetchOrganizationNameForDeletionToken({
				token: TOKEN,
				userId: "someone-else",
			}),
		).toBeNull();

		// Refused BEFORE the lookup, so a leaked link cannot be used to probe
		// which organizations exist.
		expect(organization.findFirst).not.toHaveBeenCalled();
	});

	it("never spends the token", async () => {
		const { fetchOrganizationNameForDeletionToken } = await load();
		verification.findFirst.mockResolvedValue(
			tokenRow({ organizationId: ORG_ID, userId: USER_ID }),
		);
		organization.findFirst.mockResolvedValue({ name: "Example Org" });

		await fetchOrganizationNameForDeletionToken({
			token: TOKEN,
			userId: USER_ID,
		});

		expect(verification.deleteMany).not.toHaveBeenCalled();
	});

	it("returns null for an expired link rather than throwing", async () => {
		const { fetchOrganizationNameForDeletionToken } = await load();
		verification.findFirst.mockResolvedValue(
			tokenRow({ organizationId: ORG_ID, userId: USER_ID }, -1),
		);

		// The page still renders — with its unnamed copy — and `confirm` owns
		// the single refusal message for every way a token can be invalid.
		expect(
			await fetchOrganizationNameForDeletionToken({
				token: TOKEN,
				userId: USER_ID,
			}),
		).toBeNull();
	});

	it("returns null when the organization row is gone", async () => {
		const { fetchOrganizationNameForDeletionToken } = await load();
		verification.findFirst.mockResolvedValue(
			tokenRow({ organizationId: ORG_ID, userId: USER_ID }),
		);
		organization.findFirst.mockResolvedValue(null);

		expect(
			await fetchOrganizationNameForDeletionToken({
				token: TOKEN,
				userId: USER_ID,
			}),
		).toBeNull();
	});
});
