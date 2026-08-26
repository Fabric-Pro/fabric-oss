import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A wiring guard, not a behaviour test.
 *
 * Density and column visibility shipped broken: the header received `compact`
 * and `isHidden` but neither row call site did, so choosing "Compact" shrank
 * the column header to 30px and left every row at 46px. Nothing caught it —
 * the hook was unit-tested, the component compiled, and the props are optional,
 * so omitting them is not a type error.
 *
 * That is the shape of the bug this file exists for: three call sites that have
 * to agree, where two of them silently defaulting looks exactly like a feature
 * that does not work rather than like a mistake.
 */
const LIST = readFileSync(
	path.resolve(__dirname, "../TestCasesList.tsx"),
	"utf8",
);

/** Every place a row or the header is rendered from the list. */
const CONSUMERS = ["<CasesTableHeader", "<SortableCaseRow", "<TestCaseRow"];

function propsOf(tag: string): string {
	const start = LIST.indexOf(tag);
	expect(start, `${tag} is not rendered by TestCasesList`).toBeGreaterThan(
		-1,
	);
	const end = LIST.indexOf("/>", start);
	return LIST.slice(start, end);
}

describe("display preferences reach every consumer", () => {
	it.each(CONSUMERS)("%s receives the density preference", (tag) => {
		expect(propsOf(tag)).toContain("compact=");
	});

	it.each(CONSUMERS)("%s receives the column-visibility predicate", (tag) => {
		expect(propsOf(tag)).toContain("isHidden=");
	});

	it("renders both a sortable and a plain row, so neither can be forgotten", () => {
		// The list picks between them on whether reordering is available. A guard
		// that only checked one would pass while the other shipped unwired —
		// which is exactly how this got out.
		expect(LIST).toContain("<SortableCaseRow");
		expect(LIST).toContain("<TestCaseRow");
	});
});
