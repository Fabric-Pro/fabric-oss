import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	project: vi.fn(),
	org: vi.fn(),
	load: vi.fn(),
	kit: vi.fn(),
	client: vi.fn(),
	organization: vi.fn(),
	updateCompany: vi.fn(),
	updateClient: vi.fn(),
	gate: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { organization: { findUnique: m.organization } },
	getBrandKit: m.kit,
	getRecipientBrand: m.client,
	trustedOrganizationLogoKey: (logo: string, org: string) =>
		logo === `${org}.png` ? logo : null,
}));
vi.mock("../../../orpc/procedures", () => ({
	assertProjectPermission: m.project,
	authorizeInputOrganization: m.org,
	Permissions: {
		DOCUMENT_READ: "document:read",
		DOCUMENT_UPDATE: "document:update",
		ORG_READ: "org:read",
		ORG_UPDATE: "org:update",
	},
}));
vi.mock("../../projects/lib/recipient-brand", () => ({
	loadRecipientBrandProject: m.load,
}));
vi.mock("../../projects/lib/proposal-artifact-feature", () => ({
	assertGlossyOrProposalArtifactEnabledForOrganization: m.gate,
}));
vi.mock("../../organizations/procedures/brand-kit/update-brand-kit", () => ({
	updateCompanyBrandCommand: m.updateCompany,
}));
vi.mock(
	"../../projects/procedures/recipient-brand/update-recipient-brand",
	() => ({ updateClientBrandCommand: m.updateClient }),
);

import {
	artifactBrandReadSchema,
	clientBrandSaveSchema,
	companyBrandSaveSchema,
	getArtifactBrandCommand,
	saveClientBrandCommand,
	saveCompanyBrandCommand,
} from "../lib/brand-commands";

const actor = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	vi.clearAllMocks();
	m.org.mockResolvedValue("example-org");
	m.project.mockResolvedValue({ organizationId: "example-org" });
	m.organization.mockResolvedValue({
		name: "Example Studio",
		logo: "example-org.png",
		deletedAt: null,
	});
	m.kit.mockResolvedValue({
		version: 3,
		accentColors: ["#123456"],
		guidance: "Keep concise",
		primaryColor: "#123456",
		heroKey: "secret-object",
	});
	m.client.mockResolvedValue({
		organizationId: "example-org",
		version: 5,
		name: "Example Client",
		colors: ["#654321"],
		website: "https://example.com",
		logoKey: "private-logo",
	});
	m.updateCompany.mockResolvedValue({
		outcome: "applied",
		brandKit: { version: 4, heroUrl: "https://secret.example.com" },
	});
});
describe("artifact branding commands", () => {
	it("reads confirmed project brands without storage URLs or suggestion fields", async () => {
		const result = await getArtifactBrandCommand(actor, {
			projectId: "example-project",
		});
		expect(result.company.name).toBe("Example Studio");
		expect(result.client?.version).toBe(5);
		expect(result.missingClientFields).toEqual([]);
		expect(JSON.stringify(result)).not.toMatch(
			/secret-object|private-logo|heroUrl/,
		);
		expect(m.project).toHaveBeenCalledWith(
			"example-project",
			actor.userId,
			"document:read",
		);
		expect(m.org).not.toHaveBeenCalled();
	});
	it("refuses another tenant before loading brand records", async () => {
		m.project.mockResolvedValue({ organizationId: "example-other-org" });
		await expect(
			getArtifactBrandCommand(actor, {
				projectId: "example-other-project",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.kit).not.toHaveBeenCalled();
	});
	it("checks company membership and role even for a known organization", async () => {
		m.org.mockRejectedValue(new Error("Missing permission"));
		await expect(getArtifactBrandCommand(actor, {})).rejects.toThrow(
			"Missing permission",
		);
		expect(m.kit).not.toHaveBeenCalled();
	});
	it("ignores an orphaned cross-tenant recipient record", async () => {
		m.client.mockResolvedValue({
			organizationId: "example-other-org",
			name: "Hidden",
		});
		const result = await getArtifactBrandCommand(actor, {
			projectId: "example-project",
		});
		expect(result.client).toBeNull();
		expect(result.clientVersion).toBe(0);
		expect(result.missingClientFields).toEqual(["name", "colors", "logo"]);
	});
	it("preserves omitted company values and every asset through the canonical save", async () => {
		const audit = vi.fn();
		const result = await saveCompanyBrandCommand(
			actor,
			{ expectedVersion: 3, primaryColor: "#abcdef" },
			audit,
		);
		expect(m.updateCompany).toHaveBeenCalledWith(
			actor,
			{
				organizationId: actor.organizationId,
				expectedVersion: 3,
				accentColors: ["#123456"],
				guidance: "Keep concise",
				primaryColor: "#abcdef",
				website: undefined,
			},
			audit,
		);
		expect(result).toEqual({ outcome: "applied", version: 4 });
		expect(result).not.toHaveProperty("heroUrl");
	});
	it("refuses a cross-tenant client save before mutation", async () => {
		m.project.mockResolvedValue({ organizationId: "example-other-org" });
		await expect(
			saveClientBrandCommand(
				actor,
				{
					projectId: "example-project",
					expectedVersion: 5,
					name: "Example",
					website: null,
					colors: [],
				},
				vi.fn(),
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.updateClient).not.toHaveBeenCalled();
	});
	it("keeps the current logo on reviewed client text edits", async () => {
		const input = {
			projectId: "example-project",
			expectedVersion: 5,
			name: "Example",
			website: null,
			colors: ["#123456"],
		};
		await saveClientBrandCommand(actor, input, vi.fn());
		expect(m.updateClient.mock.calls[0][1]).toEqual({
			...input,
			logo: { action: "keep" },
		});
	});
	it("requires revision, valid values and rejects authority or asset injection", () => {
		expect(
			companyBrandSaveSchema.safeParse({ expectedVersion: 1 }).success,
		).toBe(false);
		expect(
			companyBrandSaveSchema.safeParse({
				expectedVersion: 1,
				guidance: "Reviewed",
				assets: { hero: "foreign" },
			}).success,
		).toBe(false);
		expect(
			clientBrandSaveSchema.safeParse({
				projectId: "example-project",
				expectedVersion: 0,
				name: "Example",
				website: null,
				colors: ["red"],
			}).success,
		).toBe(false);
		expect(
			artifactBrandReadSchema.safeParse({ organizationId: "other" })
				.success,
		).toBe(false);
	});
});
