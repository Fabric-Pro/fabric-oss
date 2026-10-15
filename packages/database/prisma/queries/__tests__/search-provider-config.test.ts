/**
 * Mocked-db tests for getSearchProviderConfig tenant resolution.
 * Organizations resolve Firecrawl only from OrganizationSearchProvider rows;
 * the retired Organization.firecrawl* columns must never be queried.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	orgProviderFindUnique: vi.fn(),
	userProviderFindUnique: vi.fn(),
	organizationFindUnique: vi.fn(),
	userFindUnique: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		organizationSearchProvider: {
			findUnique: mocks.orgProviderFindUnique,
		},
		userSearchProvider: { findUnique: mocks.userProviderFindUnique },
		organization: { findUnique: mocks.organizationFindUnique },
		user: { findUnique: mocks.userFindUnique },
	},
}));

import { getSearchProviderConfig } from "../search-providers";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getSearchProviderConfig", () => {
	it("returns null in organization context without a unified firecrawl row, without reading Organization", async () => {
		mocks.orgProviderFindUnique.mockResolvedValue(null);

		const result = await getSearchProviderConfig({
			userId: "user-1",
			organizationId: "org-1",
			providerName: "firecrawl",
		});

		expect(result).toBeNull();
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
		expect(mocks.userFindUnique).not.toHaveBeenCalled();
	});

	it("returns the unified organization row when it is enabled with a key", async () => {
		mocks.orgProviderFindUnique.mockResolvedValue({
			encryptedApiKey: "enc-key",
			endpoint: null,
			enabled: true,
		});

		const result = await getSearchProviderConfig({
			userId: "user-1",
			organizationId: "org-1",
			providerName: "firecrawl",
		});

		expect(result).toEqual({
			encryptedApiKey: "enc-key",
			endpoint: null,
			enabled: true,
			source: "organization",
		});
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
	});
});
