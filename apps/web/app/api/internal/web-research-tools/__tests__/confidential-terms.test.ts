import { describe, expect, it } from "vitest";
import {
	buildConfidentialMatcher,
	findConfidentialMatch,
} from "../confidential-terms";

describe("confidential term filter", () => {
	it("matches a multi-word organization name as a phrase in any case, spacing or hyphenation", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Example Org Holdings",
		});

		for (const query of [
			"example org holdings revenue",
			"EXAMPLE   Org  HOLDINGS annual report",
			"example-org-holdings case study",
			"exampleorgholdings pricing",
		]) {
			expect(findConfidentialMatch(query, matcher)).toBe(
				"organization_name",
			);
		}
	});

	it("does not match one word of a multi-word name on its own", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Example Org Holdings",
		});

		expect(
			findConfidentialMatch("holdings companies market size", matcher),
		).toBeNull();
	});

	it("matches the organization slug written with a hyphen or joined", () => {
		const matcher = buildConfidentialMatcher({
			organizationSlug: "example-org",
		});

		expect(findConfidentialMatch("example-org pricing", matcher)).toBe(
			"organization_slug",
		);
		expect(findConfidentialMatch("exampleorg pricing", matcher)).toBe(
			"organization_slug",
		);
	});

	it("matches the project and client names", () => {
		const matcher = buildConfidentialMatcher({
			projectName: "Northwind Migration",
			clientName: "Contoso",
		});

		expect(
			findConfidentialMatch("northwind migration timeline", matcher),
		).toBe("project_name");
		expect(findConfidentialMatch("Contoso headcount", matcher)).toBe(
			"client_name",
		);
	});

	it("matches only on word boundaries", () => {
		const matcher = buildConfidentialMatcher({
			clientName: "Contoso",
			organizationName: "Fabric",
		});

		expect(
			findConfidentialMatch("contosoville tourism", matcher),
		).toBeNull();
		expect(findConfidentialMatch("subcontoso widgets", matcher)).toBeNull();
		expect(
			findConfidentialMatch("textile fabrication costs", matcher),
		).toBeNull();
		expect(findConfidentialMatch("prefabric housing", matcher)).toBeNull();
	});

	it("ignores single-word terms shorter than five characters", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Acme",
			projectName: "Ops",
		});

		expect(matcher).toHaveLength(0);
		expect(
			findConfidentialMatch("acme ops benchmarks", matcher),
		).toBeNull();
	});

	it("leaves an ordinary research query alone", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Example Org Holdings",
			organizationSlug: "example-org",
			projectName: "Northwind Migration",
			clientName: "Contoso",
			clientWebsite: "https://contoso.example",
			memberEmails: ["dev@example.com"],
		});

		expect(
			findConfidentialMatch(
				"cloud migration ROI benchmarks 2025",
				matcher,
			),
		).toBeNull();
	});

	it("matches a member email domain and its subdomains, but not a longer domain", () => {
		const matcher = buildConfidentialMatcher({
			memberEmails: ["dev@example.com", "ops@Example.com"],
		});

		expect(
			findConfidentialMatch("site:example.com case study", matcher),
		).toBe("member_email_domain");
		expect(findConfidentialMatch("docs.example.com/guide", matcher)).toBe(
			"member_email_domain",
		);
		expect(
			findConfidentialMatch("example.community forum", matcher),
		).toBeNull();
		expect(findConfidentialMatch("my-example.com", matcher)).toBeNull();
	});

	it("adds no term for public mail domains", () => {
		const matcher = buildConfidentialMatcher({
			memberEmails: ["someone@gmail.com", "someone@outlook.com"],
		});

		expect(matcher).toHaveLength(0);
		expect(
			findConfidentialMatch("gmail.com outage history", matcher),
		).toBeNull();
	});

	it("matches the client's website host without its www prefix", () => {
		const matcher = buildConfidentialMatcher({
			clientWebsite: "https://www.contoso.example",
		});

		expect(
			findConfidentialMatch("site:contoso.example pricing", matcher),
		).toBe("client_domain");
	});

	it("ignores empty, whitespace and malformed sources", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "   ",
			organizationSlug: null,
			projectName: "",
			clientWebsite: "not a url",
			memberEmails: [null, undefined, "no-at-sign", "x@localhost"],
		});

		expect(matcher).toHaveLength(0);
	});

	it("matches a name whatever punctuation or regex characters separate its words", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Example (Org) Ltd.",
			clientName: "Contoso, Inc.",
		});

		expect(
			findConfidentialMatch("example (org) ltd. filings", matcher),
		).toBe("organization_name");
		expect(findConfidentialMatch("example org ltd filings", matcher)).toBe(
			"organization_name",
		);
		expect(findConfidentialMatch("contoso inc revenue", matcher)).toBe(
			"client_name",
		);
		expect(findConfidentialMatch("/search/contoso/inc", matcher)).toBe(
			"client_name",
		);
	});

	it("matches a name written without its accents or apostrophe style", () => {
		const matcher = buildConfidentialMatcher({
			clientName: "Crème Exemple Hôtellerie",
			organizationName: "L'Étoile Partners",
		});

		expect(
			findConfidentialMatch("creme exemple hotellerie margins", matcher),
		).toBe("client_name");
		expect(findConfidentialMatch("L’Etoile partners report", matcher)).toBe(
			"organization_name",
		);
	});

	it("is not fooled by invisible characters inside a name", () => {
		const matcher = buildConfidentialMatcher({ clientName: "Contoso" });

		expect(findConfidentialMatch("con\u200btoso pricing", matcher)).toBe(
			"client_name",
		);
		expect(findConfidentialMatch("con\u00adtoso pricing", matcher)).toBe(
			"client_name",
		);
	});

	it("matches a short multi-word name as a phrase", () => {
		const matcher = buildConfidentialMatcher({ clientName: "Ab Co" });

		expect(findConfidentialMatch("ab co annual revenue", matcher)).toBe(
			"client_name",
		);
		expect(
			findConfidentialMatch("abco annual revenue", matcher),
		).toBeNull();
	});

	it("matches full-width and decomposed spellings of a name", () => {
		const matcher = buildConfidentialMatcher({
			clientName: "Contoso",
			organizationName: "Café Nordique",
		});
		const fullWidth = String.fromCodePoint(
			..."Contoso".split("").map((c) => c.charCodeAt(0) + 0xfee0),
		);

		expect(findConfidentialMatch(`${fullWidth} pricing`, matcher)).toBe(
			"client_name",
		);
		expect(
			findConfidentialMatch("café nordique menu prices", matcher),
		).toBe("organization_name");
	});

	it("matches a percent-encoded name, even next to a stray escape or encoded twice", () => {
		const matcher = buildConfidentialMatcher({
			organizationName: "Example Org Holdings",
		});

		for (const text of [
			"Example%20Org%20Holdings revenue",
			"q=Example%20Org%20Holdings&x=100%",
			"q=Example%20Org%20Holdings&z=%E0%A4%A",
			"q=Example%2520Org%2520Holdings",
			"q=%FF%20Example%20Org%20Holdings",
		]) {
			expect(findConfidentialMatch(text, matcher)).toBe(
				"organization_name",
			);
		}
	});
});
