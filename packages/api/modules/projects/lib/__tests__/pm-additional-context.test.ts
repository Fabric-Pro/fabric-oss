import { describe, expect, it } from "vitest";
import { readPmStringContext } from "../pm-additional-context";

describe("readPmStringContext", () => {
	it("drops the structured field-mapping settings and keeps the string hints", () => {
		expect(
			readPmStringContext({
				account_slug: "example-org",
				workItemType: "User Story",
				fieldMapping: {
					provider: "azure-devops",
					fields: [{ id: "System.Description", displayName: "Body" }],
				},
			}),
		).toEqual({ account_slug: "example-org", workItemType: "User Story" });
	});

	it("drops every non-string value, not only objects", () => {
		expect(
			readPmStringContext({
				keep: "yes",
				count: 3,
				flag: true,
				nothing: null,
				list: ["a"],
			}),
		).toEqual({ keep: "yes" });
	});

	it("returns an empty record for a context with no string entries", () => {
		expect(readPmStringContext({ fieldMapping: { fields: [] } })).toEqual(
			{},
		);
	});

	it("returns null for absent or non-object contexts", () => {
		expect(readPmStringContext(null)).toBeNull();
		expect(readPmStringContext(undefined)).toBeNull();
		expect(readPmStringContext("a string")).toBeNull();
		expect(readPmStringContext(["a", "b"])).toBeNull();
	});
});
