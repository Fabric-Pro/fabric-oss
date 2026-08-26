import { readFileSync } from "node:fs";
import path from "node:path";
import { criterionIndexFromRef } from "@repo/utils/acceptance-criteria";
import { describe, expect, it } from "vitest";

const PICKER = readFileSync(
	path.resolve(__dirname, "../AcRefPicker.tsx"),
	"utf8",
);
const CONTROL = readFileSync(
	path.resolve(__dirname, "../WorkItemLinkControl.tsx"),
	"utf8",
);

/**
 * The picker writes `AC <n>`; everything downstream resolves a ref by the first
 * integer in it. Those two have to agree, or a case picked in the editor still
 * reads as uncovered in the traceability matrix — which is the whole bug.
 */
describe("what the picker writes is what the matrix reads", () => {
	it("resolves the picker's format to the criterion index", () => {
		expect(criterionIndexFromRef("AC 3")).toBe(3);
	});

	it("still resolves the shapes rows already carry", () => {
		// Written by hand before the picker existed.
		expect(criterionIndexFromRef("3")).toBe(3);
		expect(criterionIndexFromRef("AC3")).toBe(3);
		expect(criterionIndexFromRef("criterion 3")).toBe(3);
	});

	it("treats a ref with no number as unmapped", () => {
		expect(criterionIndexFromRef("")).toBeNull();
		expect(criterionIndexFromRef("tbd")).toBeNull();
	});
});

/**
 * A wiring guard. The picker is only useful if the editor renders it; swapping
 * it back for the old free-text box is not a type error, and the unit tests
 * above would still pass.
 */
describe("the editor renders the picker", () => {
	it("the work-item link control uses AcRefPicker", () => {
		expect(CONTROL).toContain("<AcRefPicker");
	});

	/**
	 * The contract WorkItemLinkControl's doc comment states: the ref is stored
	 * BARE, because the RAG context formatter prefixes "Covers AC". Writing
	 * "AC 3" here put "Covers AC AC 3" into every case's AI-facing context — a
	 * bug the picker's own unit tests could not see, since they only exercised
	 * the traceability consumer.
	 */
	it("writes the ref bare, because the RAG formatter adds the prefix", () => {
		// Toggling a checkbox stores the criterion's index and nothing else.
		expect(PICKER).toContain("const n = String(index)");

		// Scoped to the write path on purpose. The TRIGGER legitimately renders
		// "AC 3" — that is a label a person reads. What must never carry the
		// prefix is the value handed to onChange, because the RAG context
		// formatter adds its own and the case's AI-facing context would read
		// "Covers AC AC 3".
		const toggleBody = PICKER.slice(
			PICKER.indexOf("const toggle ="),
			PICKER.indexOf("const label ="),
		);
		expect(toggleBody).not.toContain("AC ");
	});

	it("selects by resolved number, not by string equality", () => {
		// Refs stored before the picker existed are "3" or "AC3", not "AC 3";
		// comparing strings would show them as unselected and silently clear
		// the link on the next save.
		expect(PICKER).toContain("ref.match(/\\d+/)");
	});

	it("keeps the selection a set rather than a single value", () => {
		// Storage holds a list and the matrix counts a case under each criterion
		// it names. A control that writes one ref caps what the majority
		// authoring path can express, which is what under-reported coverage.
		expect(PICKER).toContain("values: string[]");
		expect(PICKER).toContain("onChange: (refs: string[]) => void");
	});

	it("falls back to free text when the parent has no parseable criteria", () => {
		expect(PICKER).toContain("criteria.length === 0");
		expect(PICKER).toContain("<Input");
	});
});
