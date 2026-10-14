/**
 * The ids a create stores for a PM item, read from the tool's answer
 * (`created-item-refs.ts`). Shared by the single-item story create
 * (`syncWorkItemToPM`), the test-case create and Link to existing item.
 *
 * Only a finite number or a non-empty string is an id. A field holding
 * anything else is skipped and the next field is read, so nothing is
 * stringified into an id like "null" or "[object Object]", and a malformed
 * field ahead of a valid one does not hide it.
 */
import { describe, expect, it } from "vitest";
import {
	extractCreatedWorkItemRefs,
	readCreatedTestCaseRefs,
} from "../created-item-refs";

const MALFORMED: [string, unknown][] = [
	["null", null],
	["an object", {}],
	["NaN", Number.NaN],
	["Infinity", Number.POSITIVE_INFINITY],
	["an array", ["wrong"]],
	["an empty string", ""],
	["a blank string", "   "],
	["a boolean", true],
];

describe("extractCreatedWorkItemRefs (the story create's id)", () => {
	it("reads valid ids as before: strings, numbers and 0, in field order", () => {
		expect(extractCreatedWorkItemRefs({ id: "abc" }).externalId).toBe(
			"abc",
		);
		expect(extractCreatedWorkItemRefs({ id: 1075 }).externalId).toBe(
			"1075",
		);
		expect(extractCreatedWorkItemRefs({ number: 0 }).externalId).toBe("0");
		// `number` comes ahead of `id` in COMMON_ID_FIELDS.
		expect(
			extractCreatedWorkItemRefs({ id: "internal", number: 12 })
				.externalId,
		).toBe("12");
		expect(
			extractCreatedWorkItemRefs({
				content: [{ type: "text", text: JSON.stringify({ id: 7 }) }],
			}).externalId,
		).toBe("7");
	});

	it.each(MALFORMED)(
		"%s in a field ahead of a valid one is skipped, and the valid one read",
		(_label, value) => {
			expect(
				extractCreatedWorkItemRefs({ number: value, key: "PROJ-12" })
					.externalId,
			).toBe("PROJ-12");
		},
	);

	it.each(MALFORMED)("%s as the only id is no id", (_label, value) => {
		expect(
			extractCreatedWorkItemRefs({ id: value, title: "x" }).externalId,
		).toBeUndefined();
	});

	it.each(MALFORMED)(
		"%s in the update tool's id field (the hint) falls back to the common fields",
		(_label, value) => {
			expect(
				extractCreatedWorkItemRefs(
					{ issueIdOrKey: value, id: "10001" },
					{ idParamHint: "issueIdOrKey" },
				).externalId,
			).toBe("10001");
		},
	);

	it("a malformed top-level id no longer hides an id nested in a wrapper", () => {
		expect(
			extractCreatedWorkItemRefs({ id: null, card: { id: "c-9" } })
				.externalId,
		).toBe("c-9");
	});
});

describe("readCreatedTestCaseRefs (the test-case create's id)", () => {
	it.each(MALFORMED)(
		"%s ahead of a valid field is skipped",
		(_label, value) => {
			expect(
				readCreatedTestCaseRefs({ card_number: value, key: "PROJ-3" })
					.externalId,
			).toBe("PROJ-3");
		},
	);

	it.each(MALFORMED)("%s as the only id is no id", (_label, value) => {
		expect(readCreatedTestCaseRefs({ id: value }).externalId).toBe("");
	});
});
