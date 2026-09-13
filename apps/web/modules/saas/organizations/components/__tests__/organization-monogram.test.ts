/**
 * The monogram that stands in for an organization logo until one is uploaded.
 *
 * Run with:
 *   pnpm --filter web test modules/saas/organizations/components/__tests__/organization-monogram.test.ts
 */
import { describe, expect, it } from "vitest";
import { inkForFill, organizationMonogram } from "../OrganizationLogo";

describe("organizationMonogram", () => {
	it("takes the first letters of the first and last words", () => {
		expect(organizationMonogram("Tech Fabric")).toBe("TF");
		expect(organizationMonogram("Acme Widgets International")).toBe("AI");
	});

	it("uses a single letter for a one-word name", () => {
		expect(organizationMonogram("TechFabric")).toBe("T");
		expect(organizationMonogram("globex")).toBe("G");
	});

	it("treats hyphens, dots and slashes as word breaks", () => {
		expect(organizationMonogram("north-star")).toBe("NS");
		expect(organizationMonogram("acme.io")).toBe("AI");
		expect(organizationMonogram("Fabric / Labs")).toBe("FL");
	});

	it("ignores punctuation-only words and never returns an empty mark", () => {
		expect(organizationMonogram("Acme & Co")).toBe("AC");
		expect(organizationMonogram("")).toBe("·");
		expect(organizationMonogram("***")).toBe("·");
	});

	it("keeps letters from any script", () => {
		expect(organizationMonogram("Über Werke")).toBe("ÜW");
		expect(organizationMonogram("東京 電機")).toBe("東電");
	});
});

describe("inkForFill", () => {
	it("uses dark ink on light brand colours and light ink on dark ones", () => {
		expect(inkForFill("#ffffff")).toBe("#111111");
		expect(inkForFill("#f5c400")).toBe("#111111");
		expect(inkForFill("#9F2A3A")).toBe("#ffffff");
		expect(inkForFill("#000")).toBe("#ffffff");
	});

	it("falls back to light ink for colours it cannot parse", () => {
		expect(inkForFill("rebeccapurple")).toBe("#ffffff");
	});
});
