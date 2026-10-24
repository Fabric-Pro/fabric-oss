/**
 * Proposal artifact mode (Fizzy #2946), without a database: the
 * organization gate, the client-document and internal predicates, the
 * trusted organization logo key, the theme token resolvers and the Style
 * tab's brand sources.
 *
 * The load-bearing assertions are the negative ones: the predicates read no
 * flag for a document that cannot be a client document, and the guest-safe
 * resolver never selects the style direction or the Brand kit guidance, so
 * neither can reach a project guest through it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	projectDocumentStyle: { findFirst: vi.fn() },
	organizationBrandKit: { findUnique: vi.fn() },
	organizationBrandSiteFetch: { findUnique: vi.fn() },
	projectRecipientBrand: { findUnique: vi.fn() },
	projectRecipientBrandSuggestion: { findFirst: vi.fn() },
	organization: { findUnique: vi.fn() },
}));
const isFeatureEnabled = vi.hoisted(() => vi.fn());
const isOrganizationMember = vi.hoisted(() => vi.fn());

vi.mock("../prisma/client", () => ({ db: fake, Prisma: {} }));
vi.mock("../prisma/queries/feature-flags", () => ({ isFeatureEnabled }));
vi.mock("../prisma/queries/verify-organization-membership", () => ({
	isOrganizationMember,
}));

import {
	isProposalArtifactEnabledForOrganization,
	isProposalClientDocument,
	isProposalInternalReader,
	PROPOSAL_DOCUMENT_TYPE,
	resolveGuestSafeProposalThemeTokens,
	resolveProposalBrandSources,
	resolveProposalThemeTokens,
	trustedOrganizationLogoKey,
} from "../prisma/queries/projects/proposal-artifact-mode";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const PROJECT = "proj-a";
const DOCUMENT = "doc-a";
const MEMBER = "user-member";
const GUEST = "user-guest";
const RECIPIENT_LOGO = `project-brand/${PROJECT}/recipient-brand/current/logo-1.png`;

const TARGET = {
	organizationId: ORG,
	projectId: PROJECT,
	documentId: DOCUMENT,
};

/** The flag is on for org A only; only MEMBER has a `member` row there. */
function gateOnForOrgA() {
	isFeatureEnabled.mockImplementation(
		async (key: string, organizationId?: string) =>
			key === "PROPOSAL_ARTIFACT" && organizationId === ORG,
	);
	isOrganizationMember.mockImplementation(
		async (userId: string, organizationId: string) =>
			userId === MEMBER && organizationId === ORG,
	);
}

function seedSources(
	overrides: {
		style?: unknown;
		brandKit?: unknown;
		siteFetch?: unknown;
		recipient?: unknown;
		suggestion?: unknown;
		organization?: unknown;
	} = {},
) {
	fake.organizationBrandSiteFetch.findUnique.mockResolvedValue(
		"siteFetch" in overrides ? overrides.siteFetch : null,
	);
	fake.projectRecipientBrandSuggestion.findFirst.mockResolvedValue(
		"suggestion" in overrides ? overrides.suggestion : null,
	);
	fake.projectDocumentStyle.findFirst.mockResolvedValue(
		"style" in overrides
			? overrides.style
			: { primaryColor: "#123456", accentColors: ["#abcdef"] },
	);
	fake.organizationBrandKit.findUnique.mockResolvedValue(
		"brandKit" in overrides
			? overrides.brandKit
			: { accentColors: ["#fedcba"] },
	);
	fake.projectRecipientBrand.findUnique.mockResolvedValue(
		"recipient" in overrides
			? overrides.recipient
			: {
					organizationId: ORG,
					name: "Example Client",
					logoKey: RECIPIENT_LOGO,
					colors: ["#0a0b0c"],
				},
	);
	fake.organization.findUnique.mockResolvedValue(
		"organization" in overrides
			? overrides.organization
			: { name: "Example Org", logo: `${ORG}.png` },
	);
}

/** Every `select` the fake client was handed, across every delegate. */
function everySelect(): Record<string, unknown>[] {
	return Object.values(fake).flatMap((delegate) =>
		Object.values(delegate).flatMap((method) =>
			method.mock.calls.map(
				([args]) =>
					(args as { select: Record<string, unknown> }).select,
			),
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	gateOnForOrgA();
	seedSources();
});

describe("isProposalArtifactEnabledForOrganization", () => {
	it("is on when the organization's gate is on, read for that organization", async () => {
		expect(await isProposalArtifactEnabledForOrganization(ORG)).toBe(true);
		expect(isFeatureEnabled).toHaveBeenCalledTimes(1);
		expect(isFeatureEnabled).toHaveBeenCalledWith("PROPOSAL_ARTIFACT", ORG);
	});

	it("is off when the organization's gate is off, read for that organization", async () => {
		expect(await isProposalArtifactEnabledForOrganization(OTHER_ORG)).toBe(
			false,
		);
		expect(isFeatureEnabled).toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			OTHER_ORG,
		);
		expect(isFeatureEnabled).not.toHaveBeenCalledWith(
			"PROPOSAL_ARTIFACT",
			ORG,
		);
	});

	it.each([null, undefined, ""])(
		"is off and never reads the flag without an organization (%o)",
		async (organizationId) => {
			expect(
				await isProposalArtifactEnabledForOrganization(organizationId),
			).toBe(false);
			expect(isFeatureEnabled).not.toHaveBeenCalled();
		},
	);

	it("agrees with the client-document predicate for a Proposal", async () => {
		for (const organizationId of [ORG, OTHER_ORG, null]) {
			expect(
				await isProposalClientDocument({
					organizationId,
					documentType: PROPOSAL_DOCUMENT_TYPE,
				}),
			).toBe(
				await isProposalArtifactEnabledForOrganization(organizationId),
			);
		}
	});
});

describe("isProposalClientDocument", () => {
	it("is a client document for a Proposal when the owning organization's gate is on", async () => {
		expect(
			await isProposalClientDocument({
				organizationId: ORG,
				documentType: PROPOSAL_DOCUMENT_TYPE,
			}),
		).toBe(true);
		expect(isFeatureEnabled).toHaveBeenCalledWith("PROPOSAL_ARTIFACT", ORG);
	});

	it("is not one when the owning organization's gate is off", async () => {
		expect(
			await isProposalClientDocument({
				organizationId: OTHER_ORG,
				documentType: "PROPOSAL",
			}),
		).toBe(false);
	});

	it.each([null, undefined, ""])(
		"never reads the flag without an organization (%o)",
		async (organizationId) => {
			expect(
				await isProposalClientDocument({
					organizationId,
					documentType: "PROPOSAL",
				}),
			).toBe(false);
			expect(isFeatureEnabled).not.toHaveBeenCalled();
		},
	);

	it.each(["BUSINESS_CASE", "PRD", "proposal"])(
		"never reads the flag for a %s",
		async (documentType) => {
			expect(
				await isProposalClientDocument({
					organizationId: ORG,
					documentType,
				}),
			).toBe(false);
			expect(isFeatureEnabled).not.toHaveBeenCalled();
		},
	);
});

describe("isProposalInternalReader", () => {
	it("a Proposal in a gate-on organization is a client document for a guest and a member, and only the member reads it as an insider", async () => {
		const proposal = { organizationId: ORG, documentType: "PROPOSAL" };

		expect(await isProposalClientDocument(proposal)).toBe(true);
		expect(
			await isProposalInternalReader({ ...proposal, userId: MEMBER }),
		).toBe(true);
		expect(
			await isProposalInternalReader({ ...proposal, userId: GUEST }),
		).toBe(false);
		// Membership of the OWNING organization, never the guest's own.
		expect(isOrganizationMember).toHaveBeenCalledWith(GUEST, ORG);
	});

	it("a Business Case passes neither predicate, for anyone, and asks nothing", async () => {
		const businessCase = {
			organizationId: ORG,
			documentType: "BUSINESS_CASE",
		};

		expect(await isProposalClientDocument(businessCase)).toBe(false);
		for (const userId of [MEMBER, GUEST]) {
			expect(
				await isProposalInternalReader({ ...businessCase, userId }),
			).toBe(false);
		}
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});

	it("asks about membership only after the gate passed", async () => {
		expect(
			await isProposalInternalReader({
				organizationId: OTHER_ORG,
				documentType: "PROPOSAL",
				userId: MEMBER,
			}),
		).toBe(false);
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});

	it("reads neither the flag nor membership without an organization", async () => {
		expect(
			await isProposalInternalReader({
				organizationId: null,
				documentType: "PROPOSAL",
				userId: MEMBER,
			}),
		).toBe(false);
		expect(isFeatureEnabled).not.toHaveBeenCalled();
		expect(isOrganizationMember).not.toHaveBeenCalled();
	});
});

describe("trustedOrganizationLogoKey", () => {
	it("trusts exactly the key the organization logo upload writes", () => {
		expect(trustedOrganizationLogoKey(`${ORG}.png`, ORG)).toBe(
			`${ORG}.png`,
		);
	});

	it.each([
		null,
		undefined,
		"",
		`${ORG}/logo.png`,
		`/${ORG}.png`,
		`https://cdn.example.com/${ORG}.png`,
		`${ORG}.png/../${OTHER_ORG}.png`,
		`${OTHER_ORG}.png`,
		"user-member.png",
		`${ORG}.PNG`,
		` ${ORG}.png`,
	])("refuses %o", (logo) => {
		expect(trustedOrganizationLogoKey(logo, ORG)).toBeNull();
	});

	it("trusts nothing for an empty organization id", () => {
		expect(trustedOrganizationLogoKey(".png", "")).toBeNull();
	});
});

describe("resolveGuestSafeProposalThemeTokens", () => {
	it("reads each source narrowly, in the owning organization", async () => {
		await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(fake.projectDocumentStyle.findFirst).toHaveBeenCalledWith({
			where: { documentId: DOCUMENT, organizationId: ORG },
			select: { primaryColor: true, accentColors: true },
		});
		expect(fake.organizationBrandKit.findUnique).toHaveBeenCalledWith({
			where: { organizationId: ORG },
			select: {
				accentColors: true,
				primaryColor: true,
				displayFontFamily: true,
				bodyFontFamily: true,
				displayFontKey: true,
				bodyFontKey: true,
				heroKey: true,
				website: true,
			},
		});
		// Only the website fetch's result, never who asked or why it failed.
		expect(fake.organizationBrandSiteFetch.findUnique).toHaveBeenCalledWith(
			{
				where: { organizationId: ORG },
				select: {
					resultWebsite: true,
					primaryColor: true,
					accentColors: true,
				},
			},
		);
		expect(
			fake.projectRecipientBrandSuggestion.findFirst,
		).not.toHaveBeenCalled();
		expect(fake.projectRecipientBrand.findUnique).toHaveBeenCalledWith({
			where: { projectId: PROJECT },
			select: {
				organizationId: true,
				name: true,
				logoKey: true,
				colors: true,
			},
		});
		expect(fake.organization.findUnique).toHaveBeenCalledWith({
			where: { id: ORG },
			select: { name: true, logo: true },
		});
	});

	it("never selects the style direction or the Brand kit guidance", async () => {
		await resolveGuestSafeProposalThemeTokens(TARGET);

		const selects = everySelect();
		expect(selects).toHaveLength(5);
		for (const select of selects) {
			expect(select).not.toHaveProperty("styleDirection");
			expect(select).not.toHaveProperty("guidance");
		}
	});

	it("applies the website fetch's colours only while it fetched the Brand kit's current website", async () => {
		const kit = {
			accentColors: [],
			website: "https://example.com",
		};
		seedSources({
			style: null,
			brandKit: kit,
			siteFetch: {
				resultWebsite: "https://example.com",
				primaryColor: "#0a2540",
				accentColors: ["#635bff"],
			},
		});
		const applied = await resolveGuestSafeProposalThemeTokens(TARGET);
		expect(applied.proposer.primary).toEqual({
			value: "#0a2540",
			source: "VENDOR_SITE",
		});
		expect(applied.proposer.accents.source).toBe("VENDOR_SITE");

		seedSources({
			style: null,
			brandKit: kit,
			siteFetch: {
				resultWebsite: "https://old.example.com",
				primaryColor: "#0a2540",
				accentColors: ["#635bff"],
			},
		});
		const stale = await resolveGuestSafeProposalThemeTokens(TARGET);
		expect(stale.proposer.primary.source).toBe("DEFAULT");
		expect(stale.proposer.accents.source).toBe("DEFAULT");
	});

	it("takes the Brand kit's hero and font files only in their own organization's shapes", async () => {
		seedSources({
			brandKit: {
				accentColors: [],
				displayFontFamily: "Example Display",
				bodyFontFamily: "Example Text",
				displayFontKey: `organization-brand/${ORG}/fonts/display-id.woff2`,
				bodyFontKey: `organization-brand/${OTHER_ORG}/fonts/body-id.woff2`,
				heroKey: `organization-brand/${ORG}/pending/hero.png`,
			},
		});

		const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(tokens.proposer.fontFiles?.display).toEqual({
			value: "display-id",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.fontFiles?.body.value).toBeNull();
		expect(tokens.proposer.hero.value).toBeNull();
	});

	it("builds the tokens from every source", async () => {
		const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(tokens.proposer.name).toEqual({
			value: "Example Org",
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.logo).toEqual({
			value: { kind: "organization-logo", key: `${ORG}.png` },
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.primary).toEqual({
			value: "#123456",
			source: "MANUAL",
		});
		expect(tokens.proposer.accents).toEqual({
			value: ["#abcdef"],
			source: "MANUAL",
		});
		expect(tokens.recipient).toEqual({
			name: { value: "Example Client", source: "MANUAL" },
			logo: {
				value: { kind: "recipient-logo", key: RECIPIENT_LOGO },
				source: "MANUAL",
			},
			colors: { value: ["#0a0b0c"], source: "MANUAL" },
		});
		expect(JSON.stringify(tokens)).not.toMatch(/styleDirection|guidance/);
	});

	it("falls back to the Brand kit accents when the Style has none", async () => {
		seedSources({ style: { primaryColor: null, accentColors: [] } });

		const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(tokens.proposer.accents).toEqual({
			value: ["#fedcba"],
			source: "BRAND_KIT",
		});
		expect(tokens.proposer.primary.source).toBe("DEFAULT");
	});

	it("ignores a recipient brand row of another organization entirely", async () => {
		seedSources({
			recipient: {
				organizationId: OTHER_ORG,
				name: "Someone Else",
				logoKey: RECIPIENT_LOGO,
				colors: ["#0a0b0c"],
			},
		});

		const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(tokens.recipient).toEqual({
			name: { value: null, source: "DEFAULT" },
			logo: { value: null, source: "DEFAULT" },
			colors: { value: [], source: "DEFAULT" },
		});
	});

	it.each([
		"project-brand/proj-b/recipient-brand/current/logo-1.png",
		`project-brand/${PROJECT}/recipient-brand/pending/logo-1.png`,
		`project-brand/${PROJECT}/recipient-brand/current/../../x.png`,
		`document-media/${PROJECT}/${DOCUMENT}/logo.png`,
	])(
		"keeps the recipient brand but drops a logo key outside this project's promoted prefix (%s)",
		async (logoKey) => {
			seedSources({
				recipient: {
					organizationId: ORG,
					name: "Example Client",
					logoKey,
					colors: [],
				},
			});

			const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

			expect(tokens.recipient.name.value).toBe("Example Client");
			expect(tokens.recipient.logo).toEqual({
				value: null,
				source: "DEFAULT",
			});
		},
	);

	it.each([
		`${OTHER_ORG}.png`,
		"https://cdn.example.com/logo.png",
		`${ORG}/logo.png`,
	])(
		"drops an organization logo that is not the upload's own key (%s)",
		async (logo) => {
			seedSources({ organization: { name: "Example Org", logo } });

			const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

			expect(tokens.proposer.name.value).toBe("Example Org");
			expect(tokens.proposer.logo).toEqual({
				value: null,
				source: "DEFAULT",
			});
		},
	);

	it("is the neutral default when no source has a row", async () => {
		seedSources({
			style: null,
			brandKit: null,
			recipient: null,
			organization: null,
		});

		const tokens = await resolveGuestSafeProposalThemeTokens(TARGET);

		expect(tokens.proposer.name).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.proposer.logo).toEqual({
			value: null,
			source: "DEFAULT",
		});
		expect(tokens.proposer.primary.source).toBe("DEFAULT");
		expect(tokens.proposer.accents.source).toBe("DEFAULT");
		expect(tokens.recipient.logo).toEqual({
			value: null,
			source: "DEFAULT",
		});
	});
});

describe("resolveProposalBrandSources", () => {
	const SITE_FETCH = {
		organizationId: ORG,
		website: "https://example.com",
		requestId: "req-1",
		status: "SUCCEEDED",
		failureCode: null,
		requestedById: MEMBER,
		requestedAt: new Date("2026-10-22T12:00:00Z"),
		resultWebsite: "https://example.com",
		primaryColor: "#0a2540",
		accentColors: ["#635bff"],
		fetchedAt: new Date("2026-10-22T12:00:05Z"),
	};
	const SUGGESTION = {
		projectId: PROJECT,
		organizationId: ORG,
		website: "https://client.example.com",
		requestId: "req-2",
		status: "SUCCEEDED",
		failureCode: null,
		requestedById: MEMBER,
		requestedAt: new Date("2026-10-22T12:00:00Z"),
		resultWebsite: "https://client.example.com",
		name: "Example Client",
		colors: ["#0b3d91"],
		logoKey: null,
		logoHash: null,
		fetchedAt: new Date("2026-10-22T12:00:05Z"),
	};

	it("reports what each source holds for the proposer's colours", async () => {
		seedSources({
			style: { primaryColor: "#123456", accentColors: ["#abcdef"] },
			brandKit: {
				accentColors: ["#fedcba"],
				primaryColor: "#1f4e79",
				website: "https://example.com",
			},
			siteFetch: SITE_FETCH,
			suggestion: SUGGESTION,
		});

		const sources = await resolveProposalBrandSources(TARGET);

		expect(sources.proposer.primary).toMatchObject({
			style: "#123456",
			brandKit: "#1f4e79",
			vendorSite: "#0a2540",
		});
		expect(sources.proposer.accents).toMatchObject({
			style: ["#abcdef"],
			brandKit: ["#fedcba"],
			vendorSite: ["#635bff"],
		});
		expect(sources.tokens.proposer.primary).toEqual({
			value: "#123456",
			source: "MANUAL",
		});
		expect(sources.brandKitWebsite).toBe("https://example.com");
		expect(sources.siteFetch).toEqual(SITE_FETCH);
		expect(sources.suggestion).toEqual(SUGGESTION);
	});

	it("inherits what the document wears without its Style", async () => {
		seedSources({
			style: { primaryColor: "#123456", accentColors: ["#abcdef"] },
			brandKit: {
				accentColors: ["#fedcba"],
				primaryColor: "#1f4e79",
				website: "https://example.com",
			},
			siteFetch: SITE_FETCH,
		});
		const kit = await resolveProposalBrandSources(TARGET);
		expect(kit.proposer.inherited).toEqual({
			primary: { value: "#1f4e79", source: "BRAND_KIT" },
			accents: { value: ["#fedcba"], source: "BRAND_KIT" },
		});

		seedSources({
			style: { primaryColor: "#123456", accentColors: ["#abcdef"] },
			brandKit: { accentColors: [], website: "https://example.com" },
			siteFetch: SITE_FETCH,
		});
		const vendor = await resolveProposalBrandSources(TARGET);
		expect(vendor.proposer.inherited).toEqual({
			primary: { value: "#0a2540", source: "VENDOR_SITE" },
			accents: { value: ["#635bff"], source: "VENDOR_SITE" },
		});
		// The document itself still wears its Style.
		expect(vendor.tokens.proposer.primary.source).toBe("MANUAL");

		seedSources({
			style: { primaryColor: "#123456", accentColors: ["#abcdef"] },
			brandKit: null,
		});
		const neutral = await resolveProposalBrandSources(TARGET);
		expect(neutral.proposer.inherited.primary.source).toBe("DEFAULT");
		expect(neutral.proposer.inherited.accents.source).toBe("DEFAULT");
	});

	it("ignores a website fetch result for another website", async () => {
		seedSources({
			style: null,
			brandKit: { accentColors: [], website: "https://example.com" },
			siteFetch: {
				...SITE_FETCH,
				website: "https://old.example.com",
				resultWebsite: "https://old.example.com",
			},
		});

		const sources = await resolveProposalBrandSources(TARGET);

		expect(sources.proposer.primary.vendorSite).toBeNull();
		expect(sources.proposer.accents.vendorSite).toEqual([]);
		expect(sources.proposer.inherited.primary.source).toBe("DEFAULT");
		expect(sources.tokens.proposer.primary.source).toBe("DEFAULT");
		// The attempt itself is still shown, for the form's status line.
		expect(sources.siteFetch?.website).toBe("https://old.example.com");
	});

	it("reads the suggestion by project in the owning organization, and the fetch by organization", async () => {
		await resolveProposalBrandSources(TARGET);

		expect(
			fake.projectRecipientBrandSuggestion.findFirst,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: PROJECT, organizationId: ORG },
			}),
		);
		for (const [args] of fake.organizationBrandSiteFetch.findUnique.mock
			.calls) {
			expect(args.where).toEqual({ organizationId: ORG });
		}
	});

	it("never selects the style direction or the Brand kit guidance", async () => {
		await resolveProposalBrandSources(TARGET);

		for (const select of everySelect()) {
			expect(select).not.toHaveProperty("styleDirection");
			expect(select).not.toHaveProperty("guidance");
		}
	});
});

describe("resolveProposalThemeTokens", () => {
	it("adds the style direction and the Brand kit guidance to the same tokens", async () => {
		const guestSafe = await resolveGuestSafeProposalThemeTokens(TARGET);
		vi.clearAllMocks();
		seedSources();
		fake.projectDocumentStyle.findFirst.mockImplementation(
			async ({ select }: { select: Record<string, unknown> }) =>
				"styleDirection" in select
					? {
							styleDirection: "Calm and precise.",
							autoVisuals: false,
						}
					: { primaryColor: "#123456", accentColors: ["#abcdef"] },
		);
		fake.organizationBrandKit.findUnique.mockImplementation(
			async ({ select }: { select: Record<string, unknown> }) =>
				"guidance" in select
					? { guidance: "Plain words." }
					: { accentColors: ["#fedcba"] },
		);

		const theme = await resolveProposalThemeTokens(TARGET);

		expect(theme).toEqual({
			tokens: guestSafe,
			styleDirection: "Calm and precise.",
			brandGuidance: "Plain words.",
			autoVisuals: false,
		});
		// The switch rides the style read the direction already makes.
		expect(fake.projectDocumentStyle.findFirst).toHaveBeenCalledTimes(2);
		expect(fake.projectDocumentStyle.findFirst).toHaveBeenCalledWith({
			where: { documentId: DOCUMENT, organizationId: ORG },
			select: { styleDirection: true, autoVisuals: true },
		});
		expect(fake.organizationBrandKit.findUnique).toHaveBeenCalledWith({
			where: { organizationId: ORG },
			select: { guidance: true },
		});
	});

	it("is null for each internal field without its row", async () => {
		fake.projectDocumentStyle.findFirst.mockResolvedValue(null);
		fake.organizationBrandKit.findUnique.mockResolvedValue(null);

		const theme = await resolveProposalThemeTokens(TARGET);

		expect(theme.styleDirection).toBeNull();
		expect(theme.brandGuidance).toBeNull();
		expect(theme.autoVisuals).toBe(true);
	});
});
