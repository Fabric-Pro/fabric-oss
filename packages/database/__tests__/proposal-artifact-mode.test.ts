/**
 * Proposal artifact mode (Fizzy #2946), without a database: the
 * organization gate, the client-document and internal predicates, the
 * trusted organization logo key, and the theme token resolvers.
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
	projectRecipientBrand: { findUnique: vi.fn() },
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
		recipient?: unknown;
		organization?: unknown;
	} = {},
) {
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
			select: { accentColors: true },
		});
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
		expect(selects).toHaveLength(4);
		for (const select of selects) {
			expect(select).not.toHaveProperty("styleDirection");
			expect(select).not.toHaveProperty("guidance");
		}
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

describe("resolveProposalThemeTokens", () => {
	it("adds the style direction and the Brand kit guidance to the same tokens", async () => {
		const guestSafe = await resolveGuestSafeProposalThemeTokens(TARGET);
		vi.clearAllMocks();
		seedSources();
		fake.projectDocumentStyle.findFirst.mockImplementation(
			async ({ select }: { select: Record<string, unknown> }) =>
				"styleDirection" in select
					? { styleDirection: "Calm and precise." }
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
		});
		expect(fake.projectDocumentStyle.findFirst).toHaveBeenCalledWith({
			where: { documentId: DOCUMENT, organizationId: ORG },
			select: { styleDirection: true },
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
	});
});
