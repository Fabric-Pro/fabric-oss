/**
 * Guards the WHERE clauses of the API-key prefix lookups.
 *
 * These assertions look pedantic and are not. The revoked-inclusive variants
 * exist ONLY so a caller can tell "this key was revoked" apart from "no such
 * key"; if an `isActive: true` filter ever reappears in them, the revoked branch
 * downstream becomes unreachable and every revoked key silently reports
 * `INVALID_API_KEY` again.
 *
 * That is exactly how the original defect hid: the route-level test mocked the
 * lookup and therefore asserted the mapping rather than the filter, so it passed
 * against production code that could never produce the input it supplied. These
 * tests assert the filter itself, which is the part that was actually wrong.
 *
 * The mirror-image assertion matters just as much: the FILTERED helpers must
 * keep their `isActive` filter, because for the callers that do not perform
 * their own check, that filter IS the revocation check.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because `vi.mock` is lifted above ordinary const declarations.
const findFirst = vi.hoisted(() => ({
	userApiKey: vi.fn().mockResolvedValue(null),
	organizationApiKey: vi.fn().mockResolvedValue(null),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userApiKey: { findFirst: findFirst.userApiKey },
		organizationApiKey: { findFirst: findFirst.organizationApiKey },
	},
}));

import {
	getOrganizationApiKeyByPrefix,
	getOrganizationApiKeyByPrefixIncludingRevoked,
} from "../prisma/queries/organization-api-keys";
import {
	getUserApiKeyByPrefix,
	getUserApiKeyByPrefixIncludingRevoked,
} from "../prisma/queries/user-api-keys";

beforeEach(() => {
	findFirst.userApiKey.mockClear();
	findFirst.organizationApiKey.mockClear();
});

describe("revoked-inclusive lookups", () => {
	it("does not filter isActive for user keys", async () => {
		await getUserApiKeyByPrefixIncludingRevoked("fab_aaaaaaaa");
		const where = findFirst.userApiKey.mock.calls[0]?.[0]?.where;
		expect(where).toEqual({ keyPrefix: "fab_aaaaaaaa" });
		expect(where).not.toHaveProperty("isActive");
	});

	it("does not filter isActive for organization keys", async () => {
		await getOrganizationApiKeyByPrefixIncludingRevoked("org_bbbbbbbb");
		const where = findFirst.organizationApiKey.mock.calls[0]?.[0]?.where;
		expect(where).toEqual({ keyPrefix: "org_bbbbbbbb" });
		expect(where).not.toHaveProperty("isActive");
	});
});

describe("filtered lookups keep their revocation check", () => {
	it("filters isActive for user keys", async () => {
		await getUserApiKeyByPrefix("fab_aaaaaaaa");
		expect(findFirst.userApiKey.mock.calls[0]?.[0]?.where).toEqual({
			keyPrefix: "fab_aaaaaaaa",
			isActive: true,
		});
	});

	it("filters isActive for organization keys", async () => {
		await getOrganizationApiKeyByPrefix("org_bbbbbbbb");
		expect(findFirst.organizationApiKey.mock.calls[0]?.[0]?.where).toEqual({
			keyPrefix: "org_bbbbbbbb",
			isActive: true,
		});
	});
});
