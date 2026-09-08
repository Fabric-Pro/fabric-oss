import {
	DATA_FIELDS,
	PROSE_FIELDS,
} from "@repo/utils/publishing-analysis-prose";
import { describe, expect, it } from "vitest";
import { PublishingPlanningAnalysisSchema } from "../build-planning-analysis-prompt";

/**
 * The Planning & Analysis schema is partitioned in TWO, and nothing else in
 * the repository checks that the partition is complete (Fizzy #1851).
 *
 * `PROSE_FIELDS` decides what a person can edit as a document; `DATA_FIELDS`
 * decides what the product keeps reading structurally. A schema field named in
 * NEITHER list vanishes from both — it never reaches the editable document, and
 * it never reaches the generation prompt's structured block. Nothing on either
 * side goes red: the document renders happily without it, and
 * `flattenPlanningAnalysis` walks only what it is handed. That silent drop is
 * the exact failure this split exists to prevent, so it needs a guard of its
 * own.
 *
 * This test lives in `@repo/temporal` because it is the only package that can
 * import both halves: the schema is owned here, and the field lists are owned
 * by `@repo/utils`, which must not depend on this package.
 *
 * The schema's keys are derived from `.shape`, never hand-copied. A copied list
 * would be a THIRD thing to keep in sync, and the first one to go stale.
 */
describe("the Planning & Analysis prose/data partition", () => {
	const schemaKeys = Object.keys(PublishingPlanningAnalysisSchema.shape);
	const prose = PROSE_FIELDS as readonly string[];
	const data = DATA_FIELDS as readonly string[];

	it("derives a non-empty key set from the schema itself", () => {
		// The negative control for every assertion below: if `.shape` ever
		// stopped enumerating (a schema wrapped in `.partial()`, a Zod major
		// that renames it), an empty key set would make "no field is missing"
		// and "no name is unknown" both vacuously true.
		expect(schemaKeys.length).toBeGreaterThan(0);
	});

	it("assigns EVERY schema field to exactly one half", () => {
		const unassigned = schemaKeys.filter(
			(key) => !prose.includes(key) && !data.includes(key),
		);

		// A field here is invisible to the editor AND to the prompt.
		expect(unassigned).toEqual([]);
	});

	it("puts no field in BOTH halves", () => {
		const both = schemaKeys.filter(
			(key) => prose.includes(key) && data.includes(key),
		);

		// A field in both is rendered twice: once as the author's prose and
		// again as a structured section the author cannot edit, so an edit
		// would silently contradict itself inside one prompt.
		expect(both).toEqual([]);
	});

	it("names nothing that is not in the schema", () => {
		const unknown = [...prose, ...data].filter(
			(key) => !schemaKeys.includes(key),
		);

		// A leftover name is a field that was renamed or removed in the schema
		// while the list kept the old spelling — which reads as coverage while
		// covering nothing.
		expect(unknown).toEqual([]);
	});

	it("has no duplicate inside either list", () => {
		expect(new Set(prose).size).toBe(prose.length);
		expect(new Set(data).size).toBe(data.length);
	});

	it("accounts for the schema exactly, with nothing left over on either side", () => {
		// The totality statement, said once as a count so a future field added
		// to both a list and the schema in the same change still has to add up.
		expect(prose.length + data.length).toBe(schemaKeys.length);
	});
});
