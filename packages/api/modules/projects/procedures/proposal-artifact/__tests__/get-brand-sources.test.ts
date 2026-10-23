/**
 * `projects.proposalArtifact.getBrandSources` (Fizzy #2946): where each of a
 * Proposal's brand values comes from, for the Style tab. Organization members
 * only, like the Style itself.
 *
 * The gate middleware, the permission decision and the internal loader are
 * the real ones, run over the world in `proposal-artifact-harness.ts`. The
 * sources resolver and the recipient brand read are mocks the tests drive;
 * the resolver's own reads are covered in the database package. The tokens
 * the mock returns are built by the real `buildProposalThemeTokens`, so the
 * resolved values and their sources are the ones the page wears. Storage
 * signing is a mock that records every key it was asked to sign.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const brand = vi.hoisted(() => ({
	resolveProposalBrandSources: vi.fn(),
	getRecipientBrand: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", async () => ({
	...(await (await import("./proposal-artifact-harness")).databaseModule()),
	resolveProposalBrandSources: brand.resolveProposalBrandSources,
	getRecipientBrand: brand.getRecipientBrand,
}));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	getStorageProvider: () => ({ getSignedUrl: brand.getSignedUrl }),
}));
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { config } from "@repo/config";
import {
	buildProposalThemeTokens,
	type ProposalThemeSources,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { ORGANIZATION_MEMBERSHIP_REQUIRED_CODE } from "../../../lib/proposal-artifact-access";
import { getProposalBrandSourcesProcedure } from "../get-brand-sources";
import {
	call,
	DOC_A,
	declaredPermission,
	declaredRoute,
	ORG_A,
	ORG_B,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const PROJECT_CONTEXTS = config.storage.bucketNames.projectContexts;
const WEBSITE = "https://client.example.com";
const RECIPIENT_LOGO = `project-brand/${PROJECT_A}/recipient-brand/current/logo-1.png`;
const SUGGESTED_LOGO = `project-brand/${PROJECT_A}/recipient-brand/suggested/found-1.png`;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REQUESTED_AT = new Date("2026-10-20T09:00:00.000Z");
const FETCHED_AT = new Date("2026-10-20T09:00:05.000Z");

interface Sources {
	theme: ProposalThemeSources;
	brandKitWebsite: string | null;
	siteFetch: Record<string, unknown> | null;
	suggestion: Record<string, unknown> | null;
}

function themeSources(
	overrides: Partial<ProposalThemeSources> = {},
): ProposalThemeSources {
	return {
		organization: { name: "Example Org", logoKey: `${ORG_A}.png` },
		style: { primaryColor: "#123456", accentColors: [] },
		brandKit: {
			accentColors: ["#abcdef"],
			primaryColor: "#1f4e79",
			displayFontFamily: "Example Display",
			bodyFontFamily: null,
			displayFontFileId: "font-1",
			bodyFontFileId: null,
			heroKey: null,
		},
		vendorSite: { primaryColor: "#1f4e79", accentColors: ["#fedcba"] },
		recipient: {
			name: "Example Client",
			logoKey: RECIPIENT_LOGO,
			colors: ["#224466"],
		},
		...overrides,
	};
}

function suggestionRow(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_A,
		organizationId: ORG_A,
		website: WEBSITE,
		requestId: "req-1",
		status: "SUCCEEDED",
		failureCode: null,
		requestedById: USERS.editor,
		requestedAt: REQUESTED_AT,
		resultWebsite: WEBSITE,
		name: "Example Client Group",
		colors: ["#224466", "#88aacc"],
		logoKey: SUGGESTED_LOGO,
		logoHash: HASH_B,
		fetchedAt: FETCHED_AT,
		...overrides,
	};
}

function recipientRow(overrides: Record<string, unknown> = {}) {
	return {
		projectId: PROJECT_A,
		organizationId: ORG_A,
		name: "Example Client",
		website: WEBSITE,
		logoKey: RECIPIENT_LOGO,
		logoHash: HASH_A,
		colors: ["#224466"],
		version: 4,
		updatedById: USERS.editor,
		updatedAt: new Date("2026-10-19T09:00:00.000Z"),
		...overrides,
	};
}

function useSources(overrides: Partial<Sources> = {}) {
	const sources: Sources = {
		theme: themeSources(),
		brandKitWebsite: "https://example.com",
		siteFetch: {
			organizationId: ORG_A,
			website: "https://example.com",
			requestId: "site-req-1",
			status: "SUCCEEDED",
			failureCode: null,
			requestedById: USERS.owner,
			requestedAt: REQUESTED_AT,
			resultWebsite: "https://example.com",
			primaryColor: "#1f4e79",
			accentColors: ["#fedcba"],
			fetchedAt: FETCHED_AT,
		},
		suggestion: suggestionRow(),
		...overrides,
	};
	const { theme } = sources;
	const inherited = buildProposalThemeTokens({ ...theme, style: null });
	brand.resolveProposalBrandSources.mockResolvedValue({
		tokens: buildProposalThemeTokens(theme),
		proposer: {
			primary: {
				style: theme.style?.primaryColor ?? null,
				brandKit: theme.brandKit?.primaryColor ?? null,
				vendorSite: theme.vendorSite?.primaryColor ?? null,
			},
			accents: {
				style: theme.style?.accentColors ?? [],
				brandKit: theme.brandKit?.accentColors ?? [],
				vendorSite: theme.vendorSite?.accentColors ?? [],
			},
			inherited: {
				primary: inherited.proposer.primary,
				accents: inherited.proposer.accents,
			},
		},
		brandKitWebsite: sources.brandKitWebsite,
		siteFetch: sources.siteFetch,
		suggestion: sources.suggestion,
	});
}

type BrandSources = {
	proposer: {
		primary: {
			alternatives: unknown[];
			resolved: unknown;
			inherited: unknown;
		};
		accents: {
			alternatives: unknown[];
			resolved: unknown;
			inherited: unknown;
		};
	};
	recipient: {
		suggestion: {
			status: string;
			failureCode: string | null;
			result: {
				logoUrl: string | null;
				alternatives: string[];
			} | null;
		} | null;
	} | null;
};

const read = async (userId: string = USERS.editor) =>
	(await call(
		getProposalBrandSourcesProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	)) as BrandSources;

beforeEach(() => {
	resetWorld();
	resetMocks();
	brand.resolveProposalBrandSources.mockReset();
	brand.getRecipientBrand.mockReset();
	brand.getSignedUrl.mockReset();
	brand.getSignedUrl.mockImplementation(
		async (key: string, options: { bucket: string }) =>
			`https://storage.example.com/${options.bucket}/${key}?signed`,
	);
	brand.getRecipientBrand.mockResolvedValue(recipientRow());
	useSources();
});

describe("getBrandSources — a member's read", () => {
	it("declares DOCUMENT_READ on the brand-sources route", () => {
		expect(declaredPermission(getProposalBrandSourcesProcedure)).toBe(
			"document:read",
		);
		expect(declaredRoute(getProposalBrandSourcesProcedure)).toEqual(
			expect.objectContaining({
				method: "GET",
				path: "/projects/{projectId}/documents/{documentId}/proposal-artifact/brand-sources",
			}),
		);
	});

	it("returns each source's value, the resolved one, and the recipient's suggestion", async () => {
		const result = await read();

		expect(result).toEqual({
			proposer: {
				primary: {
					resolved: { value: "#123456", source: "MANUAL" },
					// Without its Style the document wears the Brand kit's.
					inherited: { value: "#1f4e79", source: "BRAND_KIT" },
					style: "#123456",
					brandKit: "#1f4e79",
					vendorSite: "#1f4e79",
					// The kit and the website agree: one alternative, not two.
					alternatives: [{ source: "BRAND_KIT", value: "#1f4e79" }],
				},
				accents: {
					resolved: { value: ["#abcdef"], source: "BRAND_KIT" },
					inherited: { value: ["#abcdef"], source: "BRAND_KIT" },
					style: [],
					brandKit: ["#abcdef"],
					vendorSite: ["#fedcba"],
					alternatives: [
						{ source: "VENDOR_SITE", value: ["#fedcba"] },
					],
				},
				logo: { source: "BRAND_KIT", present: true },
				hero: { source: "DEFAULT", present: false },
				fonts: {
					display: {
						family: "Example Display",
						source: "BRAND_KIT",
						hasFile: true,
					},
					body: {
						family: "Inter",
						source: "DEFAULT",
						hasFile: false,
					},
				},
			},
			brandKitWebsite: "https://example.com",
			siteFetch: {
				website: "https://example.com",
				status: "SUCCEEDED",
				failureCode: null,
				requestedAt: REQUESTED_AT,
				resultWebsite: "https://example.com",
				fetchedAt: FETCHED_AT,
			},
			recipient: {
				website: WEBSITE,
				name: "Example Client",
				colors: ["#224466"],
				hasLogo: true,
				version: 4,
				suggestion: {
					requestId: "req-1",
					website: WEBSITE,
					status: "SUCCEEDED",
					failureCode: null,
					requestedAt: REQUESTED_AT,
					fetchedAt: FETCHED_AT,
					result: {
						name: "Example Client Group",
						colors: ["#224466", "#88aacc"],
						logoUrl: `https://storage.example.com/${PROJECT_CONTEXTS}/${SUGGESTED_LOGO}?signed`,
						alternatives: ["name", "colors", "logo"],
					},
				},
			},
		});
		expect(brand.resolveProposalBrandSources).toHaveBeenCalledWith({
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
		});
		// No storage key, and nobody's id, reaches the wire.
		const wire = JSON.stringify(result);
		expect(wire).not.toContain("requestedById");
		expect(wire).not.toContain(USERS.owner);
		expect(wire).not.toContain(RECIPIENT_LOGO);
		expect(wire).not.toContain('"logoKey"');
		expect(wire).not.toContain("font-1");
		// The suggested logo is the only read signed.
		expect(brand.getSignedUrl).toHaveBeenCalledTimes(1);
	});

	it("reads an attempt as the reader should see it: a long-running one has timed out", async () => {
		useSources({
			siteFetch: {
				organizationId: ORG_A,
				website: "https://example.com",
				requestId: "site-req-2",
				status: "RUNNING",
				failureCode: null,
				requestedById: USERS.owner,
				requestedAt: new Date(Date.now() - 10 * 60_000),
				resultWebsite: null,
				primaryColor: null,
				accentColors: [],
				fetchedAt: null,
			},
		});

		const result = (await read()) as unknown as {
			siteFetch: { status: string; failureCode: string | null };
		};

		expect(result.siteFetch).toMatchObject({
			status: "FAILED",
			failureCode: "timed_out",
		});
	});
});

describe("getBrandSources — who may read", () => {
	it.each([
		["a guest editor", USERS.guestEditor],
		["a guest viewer", USERS.guestViewer],
	])(
		"refuses %s the way the internal predicate does, before any source is read",
		async (_label, userId) => {
			const refused = await refusal(read(userId));

			expect(refused.code).toBe("FORBIDDEN");
			expect(refused.data).toEqual({
				code: ORGANIZATION_MEMBERSHIP_REQUIRED_CODE,
			});
			expect(brand.resolveProposalBrandSources).not.toHaveBeenCalled();
			expect(brand.getRecipientBrand).not.toHaveBeenCalled();
			expect(brand.getSignedUrl).not.toHaveBeenCalled();
		},
	);

	it("an outsider asking for another organization's document is NOT_FOUND", async () => {
		const refused = await refusal(
			call(
				getProposalBrandSourcesProcedure,
				{ projectId: PROJECT_B, documentId: DOC_A },
				USERS.outsider,
			),
		);

		expect(refused.code).toBe("NOT_FOUND");
		expect(brand.resolveProposalBrandSources).not.toHaveBeenCalled();
	});
});

describe("getBrandSources — proposer alternatives", () => {
	const primary = async (
		style: string | null,
		kit: string | null,
		site: string | null,
	) => {
		useSources({
			theme: themeSources({
				style: { primaryColor: style, accentColors: [] },
				brandKit: { accentColors: [], primaryColor: kit },
				vendorSite: { primaryColor: site, accentColors: [] },
			}),
		});
		return (await read()).proposer.primary;
	};

	it("offers none when every source agrees with the resolved value", async () => {
		expect(
			(await primary("#1f4e79", "#1f4e79", null)).alternatives,
		).toEqual([]);
	});

	it("offers each distinct value once, in precedence order, never the default", async () => {
		expect(await primary("#123456", "#1f4e79", "#654321")).toMatchObject({
			resolved: { value: "#123456", source: "MANUAL" },
			alternatives: [
				{ source: "BRAND_KIT", value: "#1f4e79" },
				{ source: "VENDOR_SITE", value: "#654321" },
			],
		});
		expect(await primary(null, "#1f4e79", "#654321")).toMatchObject({
			resolved: { value: "#1f4e79", source: "BRAND_KIT" },
			alternatives: [{ source: "VENDOR_SITE", value: "#654321" }],
		});
		expect(await primary(null, null, null)).toMatchObject({
			resolved: { source: "DEFAULT" },
			alternatives: [],
		});
	});

	it("names what the document inherits without its Style, by the tokens' precedence", async () => {
		expect(await primary("#123456", "#1f4e79", "#654321")).toMatchObject({
			resolved: { value: "#123456", source: "MANUAL" },
			inherited: { value: "#1f4e79", source: "BRAND_KIT" },
		});
		expect(await primary("#123456", null, "#654321")).toMatchObject({
			inherited: { value: "#654321", source: "VENDOR_SITE" },
		});
		expect(await primary("#123456", null, null)).toMatchObject({
			inherited: { value: "#334155", source: "DEFAULT" },
		});

		useSources({
			theme: themeSources({
				style: { primaryColor: null, accentColors: ["#111111"] },
				brandKit: { accentColors: [], primaryColor: null },
				vendorSite: { primaryColor: null, accentColors: ["#222222"] },
			}),
		});
		expect((await read()).proposer.accents).toMatchObject({
			resolved: { value: ["#111111"], source: "MANUAL" },
			inherited: { value: ["#222222"], source: "VENDOR_SITE" },
		});
	});

	it("a value the tokens would drop is no alternative", async () => {
		expect(await primary("#123456", "not-a-colour", null)).toMatchObject({
			brandKit: null,
			alternatives: [],
		});
	});
});

describe("getBrandSources — the recipient suggestion", () => {
	it("is not returned when it is for another website", async () => {
		useSources({
			suggestion: suggestionRow({
				website: "https://old.example.com",
				resultWebsite: "https://old.example.com",
			}),
		});

		const result = await read();

		expect(result.recipient?.suggestion).toBeNull();
		expect(brand.getSignedUrl).not.toHaveBeenCalled();
	});

	it("shows a failed re-fetch without the earlier result it could not confirm", async () => {
		useSources({
			suggestion: suggestionRow({
				status: "FAILED",
				failureCode: "unreachable",
			}),
		});

		expect((await read()).recipient?.suggestion).toMatchObject({
			status: "FAILED",
			failureCode: "unreachable",
			result: null,
		});
		expect(brand.getSignedUrl).not.toHaveBeenCalled();
	});

	it("offers no alternative for a field equal to the recipient brand", async () => {
		useSources({
			suggestion: suggestionRow({
				name: "Example Client",
				colors: ["#224466"],
				logoHash: HASH_A,
			}),
		});

		expect(
			(await read()).recipient?.suggestion?.result?.alternatives,
		).toEqual([]);
	});

	it("compares logos by hash: a row logo without a hash, or no row logo, differs", async () => {
		const logoAlternative = async (row: Record<string, unknown>) => {
			brand.getRecipientBrand.mockResolvedValue(recipientRow(row));
			useSources({
				suggestion: suggestionRow({
					name: "Example Client",
					colors: ["#224466"],
				}),
			});
			return (await read()).recipient?.suggestion?.result?.alternatives;
		};

		expect(await logoAlternative({ logoHash: HASH_B })).toEqual([]);
		expect(await logoAlternative({ logoHash: null })).toEqual(["logo"]);
		expect(
			await logoAlternative({ logoKey: null, logoHash: null }),
		).toEqual(["logo"]);
		expect(await logoAlternative({ logoHash: HASH_A })).toEqual(["logo"]);
	});

	it.each([
		[
			"another project's suggested logo",
			`project-brand/${PROJECT_B}/recipient-brand/suggested/found-1.png`,
		],
		["a current logo key", RECIPIENT_LOGO],
		["a workspace file", `workspace-files/${ORG_A}/logo.png`],
	])("signs no read for %s, and offers no logo", async (_label, logoKey) => {
		useSources({ suggestion: suggestionRow({ logoKey }) });

		const result = (await read()).recipient?.suggestion?.result;

		expect(result?.logoUrl).toBeNull();
		expect(result?.alternatives).not.toContain("logo");
		expect(brand.getSignedUrl).not.toHaveBeenCalled();
	});

	it("a failed signature leaves the suggestion without its logo, and offers none", async () => {
		brand.getSignedUrl.mockRejectedValue(new Error("storage down"));

		const result = (await read()).recipient?.suggestion?.result;

		expect(result?.logoUrl).toBeNull();
		expect(result?.alternatives).toEqual(["name", "colors"]);
	});

	it("a recipient brand left in another organization reads as none", async () => {
		brand.getRecipientBrand.mockResolvedValue(
			recipientRow({ organizationId: ORG_B }),
		);

		expect((await read()).recipient).toBeNull();
	});
});
