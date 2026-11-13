import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationFindUnique = vi.fn();
const projectFindUnique = vi.fn();
const memberFindMany = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		organization: {
			findUnique: (args: unknown) => organizationFindUnique(args),
		},
		project: { findUnique: (args: unknown) => projectFindUnique(args) },
		member: { findMany: (args: unknown) => memberFindMany(args) },
	},
}));

import { findConfidentialMatch } from "../confidential-terms";
import { loadConfidentialMatcher } from "../load-confidential-terms";

const IDS = { organizationId: "org-1", projectId: "project-1" };

describe("loadConfidentialMatcher", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		organizationFindUnique.mockResolvedValue({
			name: "Example Org Holdings",
			slug: "example-org",
		});
		projectFindUnique.mockResolvedValue({
			name: "Northwind Migration",
			recipientBrand: {
				name: "Contoso",
				website: "https://www.contoso.example",
			},
		});
		memberFindMany.mockResolvedValue([
			{ user: { email: "dev@example.com" } },
			{ user: { email: "someone@gmail.com" } },
		]);
	});

	it("builds terms from the organization, project, client and member rows", async () => {
		const matcher = await loadConfidentialMatcher(IDS);

		expect(findConfidentialMatch("example org holdings", matcher)).toBe(
			"organization_name",
		);
		expect(findConfidentialMatch("exampleorg", matcher)).toBe(
			"organization_slug",
		);
		expect(findConfidentialMatch("northwind migration", matcher)).toBe(
			"project_name",
		);
		expect(findConfidentialMatch("contoso revenue", matcher)).toBe(
			"client_name",
		);
		expect(findConfidentialMatch("contoso.example", matcher)).toBe(
			"client_name",
		);
		expect(findConfidentialMatch("site:example.com", matcher)).toBe(
			"member_email_domain",
		);
		expect(findConfidentialMatch("gmail.com", matcher)).toBeNull();
	});

	it("queries by the ids it was given", async () => {
		await loadConfidentialMatcher(IDS);

		expect(organizationFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "org-1" } }),
		);
		expect(projectFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "project-1" } }),
		);
		expect(memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { organizationId: "org-1" } }),
		);
	});

	it("matches the client's website host when the client has no name", async () => {
		projectFindUnique.mockResolvedValue({
			name: "Northwind Migration",
			recipientBrand: {
				name: null,
				website: "https://www.contoso.example",
			},
		});

		const matcher = await loadConfidentialMatcher(IDS);

		expect(findConfidentialMatch("site:contoso.example", matcher)).toBe(
			"client_domain",
		);
	});

	it("works for a project without a recipient brand", async () => {
		projectFindUnique.mockResolvedValue({
			name: "Northwind Migration",
			recipientBrand: null,
		});

		const matcher = await loadConfidentialMatcher(IDS);

		expect(findConfidentialMatch("northwind migration", matcher)).toBe(
			"project_name",
		);
	});

	it("rejects when a row is missing, so the caller never searches unfiltered", async () => {
		organizationFindUnique.mockResolvedValue(null);

		await expect(loadConfidentialMatcher(IDS)).rejects.toThrow();
	});

	it("rejects when a query fails", async () => {
		memberFindMany.mockRejectedValue(new Error("connection lost"));

		await expect(loadConfidentialMatcher(IDS)).rejects.toThrow(
			"connection lost",
		);
	});
});
