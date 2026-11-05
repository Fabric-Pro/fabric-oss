import {
	initialParameterValues,
	missingRequiredParameters,
	offerParameterValues,
	parameterValuesToSave,
	promptFieldRows,
	reportParameterFields,
} from "@saas/reports/lib/report-parameter-values";
import { describe, expect, it } from "vitest";

const parameters = {
	required: ["audience", "tone"],
	properties: {
		projectName: { type: "string" },
		audience: { type: "string", description: "Who reads it" },
		tone: { type: "string", enum: ["brief", "full"], default: "brief" },
	},
};

describe("reportParameterFields", () => {
	it("reads each parameter's schema and whether it is required", () => {
		const [projectName, audience, tone] = reportParameterFields(parameters);

		expect(projectName).toMatchObject({
			key: "projectName",
			required: false,
			hasDefault: false,
		});
		expect(audience).toMatchObject({
			key: "audience",
			required: true,
			hasDefault: false,
			schema: { type: "string", description: "Who reads it" },
		});
		expect(tone).toMatchObject({
			required: true,
			hasDefault: true,
			schema: { enum: ["brief", "full"], default: "brief" },
		});
	});

	it("has no fields without a schema", () => {
		expect(reportParameterFields(null)).toEqual([]);
		expect(reportParameterFields({ properties: null })).toEqual([]);
	});

	it("reads an unknown type as text", () => {
		expect(
			reportParameterFields({ properties: { x: { type: "object" } } })[0]
				.schema.type,
		).toBe("string");
	});
});

describe("initialParameterValues", () => {
	it("fills the template's values and the project's name", () => {
		expect(initialParameterValues(parameters, "Example Project")).toEqual({
			tone: "brief",
			projectName: "Example Project",
		});
	});

	it("leaves the project's parameters empty until its name arrives", () => {
		expect(initialParameterValues(parameters, null)).toEqual({
			tone: "brief",
		});
	});
});

describe("offerParameterValues", () => {
	it("fills an empty field", () => {
		expect(
			offerParameterValues(
				{ focus: "kept" },
				{ audience: "Delivery team" },
				new Set(),
			),
		).toEqual({ focus: "kept", audience: "Delivery team" });
	});

	it("never overwrites a typed value", () => {
		const current = { audience: "Typed by a person" };

		expect(
			offerParameterValues(
				current,
				{ audience: "Delivery team" },
				new Set(["audience"]),
			),
		).toBe(current);
	});

	it("leaves a field the person cleared empty", () => {
		const current = { audience: "" };

		expect(
			offerParameterValues(
				current,
				{ audience: "Delivery team" },
				new Set(["audience"]),
			),
		).toBe(current);
	});

	it("never overwrites a value already there, typed or not", () => {
		const current = { projectName: "Example Project" };

		expect(
			offerParameterValues(
				current,
				{ projectName: "Suggested" },
				new Set(),
			),
		).toBe(current);
	});

	it("keeps the same object when nothing changes, so nothing re-renders", () => {
		const current = { audience: "Delivery team" };

		expect(offerParameterValues(current, {}, new Set())).toBe(current);
	});

	it("turns an offered number into the field's text", () => {
		expect(offerParameterValues({}, { count: 3 }, new Set())).toEqual({
			count: "3",
		});
	});
});

describe("parameterValuesToSave", () => {
	it("saves what was typed and what AI filled", () => {
		expect(
			parameterValuesToSave(
				{ audience: "Typed", focus: "Delivery", tone: "brief" },
				new Set(["audience"]),
				{ focus: "Delivery" },
			),
		).toEqual({ audience: "Typed", focus: "Delivery" });
	});

	it("leaves out what the server gives a new report by itself", () => {
		expect(
			parameterValuesToSave(
				{ projectName: "Example Project" },
				new Set(),
				{},
			),
		).toEqual({});
	});

	it("does not save AI's value once a person replaced it with nothing", () => {
		expect(
			parameterValuesToSave({ focus: "" }, new Set(["focus"]), {
				focus: "Delivery",
			}),
		).toEqual({});
	});
});

describe("missingRequiredParameters", () => {
	it("names a required parameter still empty, and not one with a default", () => {
		const fields = reportParameterFields(parameters);

		expect(missingRequiredParameters(fields, {})).toEqual(["audience"]);
		expect(
			missingRequiredParameters(fields, { audience: "Delivery team" }),
		).toEqual([]);
		expect(missingRequiredParameters(fields, { audience: "  " })).toEqual([
			"audience",
		]);
	});
});

describe("promptFieldRows", () => {
	it("gives a long prompt enough rows to read without scrolling", () => {
		expect(promptFieldRows("short")).toBe(4);
		expect(promptFieldRows(Array(10).fill("line").join("\n"))).toBe(11);
		expect(promptFieldRows("x".repeat(800))).toBe(11);
	});

	it("stops growing a very long prompt's field at a cap", () => {
		expect(promptFieldRows("x".repeat(80_000))).toBe(16);
		expect(promptFieldRows(Array(500).fill("line").join("\n"))).toBe(16);
	});
});
