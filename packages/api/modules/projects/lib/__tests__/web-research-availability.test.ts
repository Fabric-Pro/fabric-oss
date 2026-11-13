/**
 * Web research availability: one search-capable and one read-capable provider
 * row, each enabled with a stored key, from the organization only.
 *
 * `@repo/search` is the real registry, not a stub, so the search half is pinned
 * against the providers that actually exist (Cloudflare cannot search, Parallel
 * cannot read, `youtube` is not a web provider at all). The decrypt helper is a
 * spy: the answer is configuration presence and must never read a key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getEnabledOrganizationSearchProviders: vi.fn(),
		getEnabledUserSearchProviders: vi.fn(),
		decryptApiKey: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {},
	getEnabledOrganizationSearchProviders:
		mocks.getEnabledOrganizationSearchProviders,
	getEnabledUserSearchProviders: mocks.getEnabledUserSearchProviders,
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/utils")>()),
	decryptApiKey: mocks.decryptApiKey,
}));

import {
	computeWebResearchAvailability,
	loadWebResearchAvailability,
	type WebResearchProviderRow,
} from "../web-research-availability";

function row(
	providerName: string,
	overrides: Partial<WebResearchProviderRow> = {},
): WebResearchProviderRow {
	return {
		providerName,
		enabled: true,
		encryptedApiKey: `encrypted-${providerName}-key`,
		...overrides,
	};
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
});

describe("computeWebResearchAvailability", () => {
	it("is available with Firecrawl alone, which both searches and reads", () => {
		expect(computeWebResearchAvailability([row("firecrawl")])).toEqual({
			available: true,
			missing: [],
		});
	});

	it("misses search with Cloudflare alone, which only reads", () => {
		expect(computeWebResearchAvailability([row("cloudflare")])).toEqual({
			available: false,
			missing: ["search"],
		});
	});

	it("misses read with Parallel alone, which only searches", () => {
		expect(computeWebResearchAvailability([row("parallel")])).toEqual({
			available: false,
			missing: ["read"],
		});
	});

	it("is available with Exa for search and Jina for reading", () => {
		expect(
			computeWebResearchAvailability([row("exa"), row("jina")]),
		).toEqual({ available: true, missing: [] });
	});

	it("combines two rows when neither can do both", () => {
		expect(
			computeWebResearchAvailability([
				row("parallel"),
				row("cloudflare"),
			]),
		).toEqual({ available: true, missing: [] });
	});

	it.each([
		["null", null],
		["empty", ""],
	])("treats an enabled row with a %s key as absent", (_label, key) => {
		expect(
			computeWebResearchAvailability([
				row("firecrawl", { encryptedApiKey: key }),
			]),
		).toEqual({ available: false, missing: ["search", "read"] });
	});

	it("treats a disabled row as absent", () => {
		expect(
			computeWebResearchAvailability([
				row("firecrawl", { enabled: false }),
			]),
		).toEqual({ available: false, missing: ["search", "read"] });
	});

	it("does not let a keyless search row complete a keyed read row", () => {
		expect(
			computeWebResearchAvailability([
				row("parallel", { encryptedApiKey: null }),
				row("cloudflare"),
			]),
		).toEqual({ available: false, missing: ["search"] });
	});

	it("does not let a disabled read row complete a keyed search row", () => {
		expect(
			computeWebResearchAvailability([
				row("parallel"),
				row("cloudflare", { enabled: false }),
			]),
		).toEqual({ available: false, missing: ["read"] });
	});

	it("treats an unknown provider name as absent for both halves", () => {
		expect(computeWebResearchAvailability([row("youtube")])).toEqual({
			available: false,
			missing: ["search", "read"],
		});
	});

	it("reports both halves missing for an empty list", () => {
		expect(computeWebResearchAvailability([])).toEqual({
			available: false,
			missing: ["search", "read"],
		});
	});

	it("never decrypts a key", () => {
		computeWebResearchAvailability([
			row("firecrawl"),
			row("exa"),
			row("cloudflare"),
		]);

		expect(mocks.decryptApiKey).not.toHaveBeenCalled();
	});
});

describe("loadWebResearchAvailability", () => {
	it("reads the organization's enabled providers", async () => {
		mocks.getEnabledOrganizationSearchProviders.mockResolvedValue([
			row("firecrawl"),
		]);

		await expect(
			loadWebResearchAvailability("org-example"),
		).resolves.toEqual({ available: true, missing: [] });
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).toHaveBeenCalledWith("org-example");
		expect(mocks.getEnabledUserSearchProviders).not.toHaveBeenCalled();
		expect(mocks.decryptApiKey).not.toHaveBeenCalled();
	});

	it("answers unavailable without any provider read when there is no organization", async () => {
		await expect(loadWebResearchAvailability(null)).resolves.toEqual({
			available: false,
			missing: ["search", "read"],
		});
		expect(
			mocks.getEnabledOrganizationSearchProviders,
		).not.toHaveBeenCalled();
		// The organization is the only tenant: no personal providers either.
		expect(mocks.getEnabledUserSearchProviders).not.toHaveBeenCalled();
	});
});
