import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirstMock = vi.fn();
vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: {
			findFirst: (args: unknown) => findFirstMock(args),
		},
		// Org-context fetches gate on actual membership; these tests exercise
		// the credential MAPPER, so the caller is always a member here.
		member: {
			findFirst: async () => ({ id: "member-row-1" }),
		},
	},
}));
vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
}));

import {
	fetchCredentialsById,
	fetchCredentialsByIdInTenant,
} from "../prisma/queries/workflows/credential-fetcher";

describe("DATABRICKS_VECTOR_SEARCH credential mapper", () => {
	beforeEach(() => findFirstMock.mockReset());

	it("maps host/clientId/clientSecret to DATABRICKS_* keys", async () => {
		findFirstMock.mockResolvedValue({
			id: "int-1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
			credentials: `enc:${JSON.stringify({
				host: "https://adb-test.azuredatabricks.net",
				clientId: "sp",
				clientSecret: "secret",
			})}`,
		});

		const creds = await fetchCredentialsById("int-1", "user-1");

		expect(creds).toMatchObject({
			DATABRICKS_HOST: "https://adb-test.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "sp",
			DATABRICKS_CLIENT_SECRET: "secret",
		});
	});

	it("returns null when no matching integration is found", async () => {
		findFirstMock.mockResolvedValue(null);

		const creds = await fetchCredentialsById("missing", "user-1");

		expect(creds).toBeNull();
	});
});

describe("fetchCredentialsByIdInTenant", () => {
	beforeEach(() => findFirstMock.mockReset());

	it("looks up by organization in org context, without a userId filter", async () => {
		findFirstMock.mockResolvedValue({
			id: "int-1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
			credentials: `enc:${JSON.stringify({
				host: "https://adb-test.azuredatabricks.net",
				clientId: "sp",
				clientSecret: "secret",
			})}`,
		});

		const creds = await fetchCredentialsByIdInTenant(
			"int-1",
			"user-1",
			"org-1",
		);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-1",
				isActive: true,
				organizationId: "org-1",
			},
		});
		expect(creds).toMatchObject({
			DATABRICKS_HOST: "https://adb-test.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "sp",
			DATABRICKS_CLIENT_SECRET: "secret",
		});
	});

	it("looks up by user in personal context, requiring organizationId: null", async () => {
		findFirstMock.mockResolvedValue({
			id: "int-2",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
			credentials: `enc:${JSON.stringify({
				host: "https://adb-test.azuredatabricks.net",
				clientId: "sp",
				clientSecret: "secret",
			})}`,
		});

		const creds = await fetchCredentialsByIdInTenant("int-2", "user-1");

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-2",
				isActive: true,
				userId: "user-1",
				organizationId: null,
			},
		});
		expect(creds).toMatchObject({
			DATABRICKS_HOST: "https://adb-test.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "sp",
			DATABRICKS_CLIENT_SECRET: "secret",
		});
	});
});
