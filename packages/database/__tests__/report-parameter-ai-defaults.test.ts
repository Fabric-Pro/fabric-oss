import { describe, expect, it } from "vitest";
import { aiFillableParameters } from "../prisma/queries/lib/report-parameter-ai-defaults";

function keys(properties: Record<string, unknown>, filled = {}) {
	return aiFillableParameters({ properties }, filled).map(({ key }) => key);
}

describe("aiFillableParameters", () => {
	it("offers an empty free-text parameter with its description", () => {
		expect(
			aiFillableParameters(
				{
					properties: {
						audience: {
							type: "string",
							description: " Who reads it ",
						},
						notes: { format: "textarea" },
					},
				},
				{},
			),
		).toEqual([
			{ key: "audience", description: "Who reads it" },
			{ key: "notes" },
		]);
	});

	it("never overwrites a value another source filled", () => {
		expect(
			keys(
				{ audience: { type: "string" }, focus: { type: "string" } },
				{ audience: "Typed by a person", focus: "   " },
			),
		).toEqual(["focus"]);
	});

	it("leaves out a parameter marked aiDefault false", () => {
		expect(
			keys({
				businessContext: { type: "string", aiDefault: false },
				department: { type: "string", aiDefault: false },
				presenter: { type: "string", aiDefault: false },
				audience: { type: "string" },
			}),
		).toEqual(["audience"]);
	});

	it("leaves out enums and values that are not text", () => {
		expect(
			keys({
				tone: { type: "string", enum: ["brief", "full"] },
				count: { type: "number" },
				enabled: { type: "boolean" },
				audience: { type: "string" },
			}),
		).toEqual(["audience"]);
	});

	it("leaves out dates and periods, however they are named", () => {
		expect(
			keys({
				startDate: { type: "string" },
				reportingPeriod: { type: "string" },
				releasedOn: { type: "string", format: "date" },
				audience: { type: "string" },
			}),
		).toEqual(["audience"]);
	});

	it("leaves out a formatted value, which would be invented", () => {
		expect(
			keys({
				contact: { type: "string", format: "email" },
				link: { type: "string", format: "uri" },
				audience: { type: "string" },
			}),
		).toEqual(["audience"]);
	});

	it("leaves what the project answers to the project", () => {
		expect(
			keys({
				projectName: { type: "string" },
				owner: { type: "string" },
				repo: { type: "string" },
				audience: { type: "string" },
			}),
		).toEqual(["audience"]);
	});

	it("offers nothing without a parameter schema", () => {
		expect(aiFillableParameters(null, {})).toEqual([]);
		expect(aiFillableParameters({ properties: null }, {})).toEqual([]);
	});
});
