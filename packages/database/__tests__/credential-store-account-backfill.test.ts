/**
 * The account backfill's two queries: members' GitHub credentials are read
 * only in the given organization, never organization-owned rows or app
 * installations, and never the secret; the account write is fenced on the
 * generation and on the row still naming no account, never touches the
 * secret, and answers false (not a crash) when the account already has a
 * grant for this owner (`credential_account_grant_key`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	updateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		credential: {
			findMany: mocks.findMany,
			updateMany: mocks.updateMany,
		},
	},
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => value,
	decryptApiKey: (value: string) => value,
}));

import {
	listMemberGitHubCredentials,
	recordCredentialAccountIfGeneration,
} from "../prisma/queries/credential-store";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findMany.mockResolvedValue([]);
	mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("listMemberGitHubCredentials", () => {
	it("reads the members' own GitHub credentials in one organization, without a secret", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "cred-1",
				userId: "user-1",
				kind: "PAT",
				origin: "https://github.com",
				generation: 1,
				externalAccountLogin: null,
			},
		]);
		const rows = await listMemberGitHubCredentials({
			organizationId: "org-1",
			userIds: ["user-1"],
		});
		const args = mocks.findMany.mock.calls[0]?.[0];
		expect(args.where).toEqual({
			organizationId: "org-1",
			userId: { in: ["user-1"] },
			provider: "GITHUB",
			kind: { not: "APP_INSTALLATION" },
			status: { not: "REVOKED" },
		});
		expect(args.select).not.toHaveProperty("encryptedSecret");
		expect(rows).toHaveLength(1);
	});

	it("asks nothing for no members", async () => {
		await expect(
			listMemberGitHubCredentials({
				organizationId: "org-1",
				userIds: [],
			}),
		).resolves.toEqual([]);
		expect(mocks.findMany).not.toHaveBeenCalled();
	});
});

describe("recordCredentialAccountIfGeneration", () => {
	const input = {
		id: "cred-1",
		organizationId: "org-1",
		generation: 3,
		externalAccountId: "42",
		externalAccountLogin: "example-dev",
		scopes: ["repo"],
	};

	it("writes the account fields only, fenced on generation and a missing account", async () => {
		await expect(recordCredentialAccountIfGeneration(input)).resolves.toBe(
			true,
		);
		const { where, data } = mocks.updateMany.mock.calls[0]?.[0] ?? {};
		expect(where).toEqual({
			id: "cred-1",
			organizationId: "org-1",
			generation: 3,
			externalAccountLogin: null,
			status: { not: "REVOKED" },
		});
		expect(Object.keys(data).sort()).toEqual([
			"externalAccountId",
			"externalAccountLogin",
			"lastCheckedAt",
			"scopes",
		]);
	});

	it("answers false when the row moved on", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		await expect(recordCredentialAccountIfGeneration(input)).resolves.toBe(
			false,
		);
	});

	it("answers false when the account already has a grant for this owner", async () => {
		mocks.updateMany.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);
		await expect(recordCredentialAccountIfGeneration(input)).resolves.toBe(
			false,
		);
	});

	it("rethrows any other failure", async () => {
		mocks.updateMany.mockRejectedValue(new Error("connection lost"));
		await expect(
			recordCredentialAccountIfGeneration(input),
		).rejects.toThrow("connection lost");
	});
});
