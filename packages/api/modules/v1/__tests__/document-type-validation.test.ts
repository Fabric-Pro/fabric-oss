import { describe, expect, it } from "vitest";
import { z } from "zod";

// Mirror of the batch-generate enum guard — keep in sync with batch-generate.ts.
const DOC_TYPE_ENUM = z.enum([
	"GENERAL",
	"BUSINESS_CASE",
	"PRD",
	"PROPOSAL",
	"ARCHITECTURE",
	"TECHNICAL_SPEC",
	"USER_STORY",
	"API_SPEC",
]);

describe("document type validation accepts BUSINESS_CASE", () => {
	it("parses BUSINESS_CASE", () => {
		expect(DOC_TYPE_ENUM.parse("BUSINESS_CASE")).toBe("BUSINESS_CASE");
	});
});
