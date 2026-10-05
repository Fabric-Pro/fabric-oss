/**
 * A GitLab Data Connection holds no credential: a GitLab sync resolves the
 * GitLab connection of the person who starts it. The write helpers that know
 * the provider refuse token material for a GitLab row, so a future caller
 * cannot quietly reintroduce a copy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dataConnection = vi.hoisted(() => ({
	create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
		id: "conn-1",
		...args.data,
	})),
	update: vi.fn(),
	findFirst: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { dataConnection },
	Prisma: { JsonNull: "JsonNull" },
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `enc:${value}`,
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
	decryptApiKeyMaybe: (value: string | null | undefined) =>
		value ? value.replace(/^enc:/, "") : value,
	isEncryptedApiKey: (value: string) => value.startsWith("enc:"),
}));

import {
	createDataConnection,
	getDataConnectionSyncMetadata,
	upsertDataConnection,
} from "../prisma/queries/data-connections";

const base = {
	userId: "user-1",
	organizationId: "org-1",
	name: "GitLab",
	createdBy: "user-1",
};

describe("GitLab Data Connection writes refuse token material", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dataConnection.findFirst.mockResolvedValue(null);
	});

	it.each([
		["accessToken", { accessToken: "glpat-example" }],
		["refreshToken", { refreshToken: "refresh-example" }],
		["tokenExpiresAt", { tokenExpiresAt: new Date(0) }],
		["credentials", { credentials: { apiKey: "glpat-example" } }],
		["credentialId", { credentialId: "cred-1" }],
	])("createDataConnection refuses %s", async (_field, secret) => {
		await expect(
			createDataConnection({ ...base, provider: "GITLAB", ...secret }),
		).rejects.toThrow("A GitLab data connection cannot store credentials");
		expect(dataConnection.create).not.toHaveBeenCalled();
	});

	it("upsertDataConnection refuses a GitLab token", async () => {
		await expect(
			upsertDataConnection({
				...base,
				provider: "GITLAB",
				externalWorkspaceId: "42",
				accessToken: "glpat-example",
			}),
		).rejects.toThrow("A GitLab data connection cannot store credentials");
		expect(dataConnection.create).not.toHaveBeenCalled();
		expect(dataConnection.update).not.toHaveBeenCalled();
	});

	it("creates a GitLab connection that carries only config", async () => {
		await createDataConnection({
			...base,
			provider: "GITLAB",
			config: { baseUrl: "https://gitlab.example.com" },
			status: "CONNECTED",
		});

		expect(dataConnection.create).toHaveBeenCalledOnce();
	});

	it("still stores tokens for other providers", async () => {
		await createDataConnection({
			...base,
			provider: "GITHUB",
			accessToken: "gh-example",
		});

		expect(dataConnection.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					accessToken: "enc:gh-example",
				}),
			}),
		);
	});
});

describe("getDataConnectionSyncMetadata", () => {
	it("selects no credential column, tenant-filtered", async () => {
		dataConnection.findFirst.mockResolvedValue(null);

		await getDataConnectionSyncMetadata({
			id: "conn-1",
			userId: "user-1",
			organizationId: "org-1",
		});

		const [args] = dataConnection.findFirst.mock.calls[0]!;
		expect(args.where).toEqual({ id: "conn-1", organizationId: "org-1" });
		expect(Object.keys(args.select).sort()).toEqual([
			"config",
			"id",
			"lastSyncAt",
			"name",
			"provider",
			"status",
		]);
	});
});
