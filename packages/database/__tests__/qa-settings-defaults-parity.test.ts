/**
 * The two places a QA-settings default can live must agree.
 *
 * `QA_SETTINGS_DEFAULTS` is what an UNCONFIGURED project reads — the query layer
 * synthesises it so viewing the page never writes a row. The Prisma column
 * `@default(...)` is what gets written the first time a project saves ANYTHING,
 * because `upsertProjectQaSettings` takes its create branch and Prisma fills
 * every column the caller omitted.
 *
 * When those two disagree, a project silently changes behaviour the moment it
 * saves an unrelated setting. That shipped once: `scepticRoles` read as `["ux"]`
 * but the column defaulted to `[]`, so saving (say) a confidence threshold
 * dropped UX Skeptic — the one persona the split deliberately keeps on. Observed
 * on staging while verifying Fizzy #2186: a partial update came back with
 * `scepticRoles: []`.
 *
 * Parsing the schema rather than importing a constant is the point: the column
 * default is the thing that can drift, and it is only expressible in the schema.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { QA_SETTINGS_DEFAULTS } from "../prisma/queries/projects/qa-settings";

const SCHEMA = resolve(__dirname, "../prisma/schema.prisma");

/** The `ProjectQaSettings` block, so a same-named field elsewhere cannot match. */
function modelBlock(): string {
	const src = readFileSync(SCHEMA, "utf8");
	const start = src.indexOf("model ProjectQaSettings {");
	if (start === -1) {
		throw new Error("model ProjectQaSettings not found");
	}
	const end = src.indexOf("\n}", start);
	return src.slice(start, end);
}

/** `@default(...)` for one field, as written in the schema. */
function columnDefault(field: string): string | undefined {
	const line = modelBlock()
		.split("\n")
		.find((l) => new RegExp(`^\\s*${field}\\s`).test(l));
	return line?.match(/@default\(([^)]*)\)/)?.[1]?.trim();
}

/** Schema list literal -> JS array, e.g. `["ux"]` -> `["ux"]`. */
function parseList(literal: string): string[] {
	const inner = literal.replace(/^\[/, "").replace(/\]$/, "").trim();
	if (!inner) {
		return [];
	}
	return inner.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

describe("QA settings defaults: query layer vs Prisma column", () => {
	it("parsed the model block", () => {
		// A parser that matched nothing would make every assertion below vacuously
		// true — the failure mode that makes a green guard worthless.
		expect(modelBlock()).toContain("testCoverageTarget");
		expect(columnDefault("coverageTarget")).toBe("80");
	});

	describe("list defaults agree", () => {
		for (const field of [
			"resolutions",
			"browsers",
			"scepticRoles",
		] as const) {
			it(`${field}`, () => {
				const raw = columnDefault(field);
				expect(
					raw,
					`${field} has no @default in the schema`,
				).toBeDefined();
				expect(
					parseList(raw as string),
					`${field}: the column writes this on first save, but an unconfigured project reads QA_SETTINGS_DEFAULTS — they must match`,
				).toEqual(QA_SETTINGS_DEFAULTS[field]);
			});
		}
	});

	describe("scalar defaults agree", () => {
		for (const [field, cast] of [
			["coverageTarget", Number],
			["testCoverageTarget", Number],
			["confidenceThreshold", Number],
			["requiredQaSignOffs", Number],
			["evidenceRetentionDays", Number],
			["pipelineSyncIntervalMinutes", Number],
		] as const) {
			it(`${field}`, () => {
				const raw = columnDefault(field);
				expect(raw, `${field} has no @default`).toBeDefined();
				expect(cast(raw as string)).toBe(QA_SETTINGS_DEFAULTS[field]);
			});
		}

		for (const field of [
			"indexCoverageEnabled",
			"scepticRolesEnabled",
			"pipelineSyncEnabled",
		] as const) {
			it(`${field}`, () => {
				expect(columnDefault(field) === "true").toBe(
					QA_SETTINGS_DEFAULTS[field],
				);
			});
		}
	});

	it("the gate ships disarmed in BOTH layers", () => {
		// The load-bearing one for Fizzy #2186: nobody inherits a Done gate they
		// did not choose, whether the row exists yet or not.
		expect(QA_SETTINGS_DEFAULTS.testCoverageTarget).toBe(0);
		expect(columnDefault("testCoverageTarget")).toBe("0");
	});
});
