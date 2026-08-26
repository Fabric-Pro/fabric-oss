/**
 * `findImportCycles` — the architecture lens's whole basis.
 *
 * Tested exhaustively because this is what makes the lens exempt from the QA
 * lens's <20% false-positive bar: a cycle either exists in the graph or it does
 * not, and that claim is only as good as this function. If it reports a cycle
 * that is not there, the lens becomes exactly the confidently-wrong tool the bar
 * exists to guard against.
 */

import { describe, expect, it } from "vitest";

import { findImportCycles } from "../lib/import-cycles";

const edge = (from: string, to: string) => ({ from, to });

describe("findImportCycles", () => {
	it("finds nothing in an empty graph", () => {
		expect(findImportCycles([])).toEqual([]);
	});

	it("finds nothing in a straight chain", () => {
		expect(findImportCycles([edge("a", "b"), edge("b", "c")])).toEqual([]);
	});

	it("finds nothing in a diamond — shared dependencies are not cycles", () => {
		// The single most likely false positive: a → b, a → c, b → d, c → d looks
		// tangled and is perfectly acyclic.
		const cycles = findImportCycles([
			edge("a", "b"),
			edge("a", "c"),
			edge("b", "d"),
			edge("c", "d"),
		]);

		expect(cycles).toEqual([]);
	});

	it("ignores a self-import", () => {
		// A file importing itself is a parser artifact or a re-export, never the
		// architectural problem being looked for.
		expect(findImportCycles([edge("a", "a")])).toEqual([]);
	});

	it("finds a two-node cycle and reports the path back", () => {
		const cycles = findImportCycles([edge("a", "b"), edge("b", "a")]);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].members).toEqual(["a", "b"]);
		expect(cycles[0].path).toEqual(["a", "b", "a"]);
	});

	it("finds a three-node cycle", () => {
		const cycles = findImportCycles([
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "a"),
		]);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].members).toEqual(["a", "b", "c"]);
		expect(cycles[0].path).toEqual(["a", "b", "c", "a"]);
	});

	it("reports two disjoint cycles separately", () => {
		const cycles = findImportCycles([
			edge("a", "b"),
			edge("b", "a"),
			edge("x", "y"),
			edge("y", "x"),
		]);

		expect(cycles).toHaveLength(2);
		expect(cycles.map((c) => c.members)).toEqual([
			["a", "b"],
			["x", "y"],
		]);
	});

	it("reports one tangled component ONCE, not every cycle through it", () => {
		// A fully-connected trio has many distinct cycles. What a reader can act on
		// is "these three form a knot", once — enumerating all of them is noise.
		const cycles = findImportCycles([
			edge("a", "b"),
			edge("b", "c"),
			edge("c", "a"),
			edge("b", "a"),
			edge("c", "b"),
			edge("a", "c"),
		]);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].members).toEqual(["a", "b", "c"]);
	});

	it("reports the SHORTEST path through a knot, not an arbitrary one", () => {
		// a↔b is a 2-hop cycle; a→c→d→b→a is a longer one through the same
		// component. The short one is what somebody can read and break.
		const cycles = findImportCycles([
			edge("a", "b"),
			edge("b", "a"),
			edge("a", "c"),
			edge("c", "d"),
			edge("d", "b"),
		]);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].path).toEqual(["a", "b", "a"]);
	});

	it("separates a cycle from the acyclic nodes hanging off it", () => {
		const cycles = findImportCycles([
			edge("entry", "a"),
			edge("a", "b"),
			edge("b", "a"),
			edge("b", "leaf"),
		]);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].members).toEqual(["a", "b"]);
	});

	it("is stable: the same graph in a different edge order gives the same answer", () => {
		// A re-run must not reshuffle the finding list, or every analysis looks
		// like it found something new.
		const edges = [
			edge("b", "c"),
			edge("x", "y"),
			edge("c", "b"),
			edge("y", "x"),
		];
		const first = findImportCycles(edges);
		const second = findImportCycles([...edges].reverse());

		expect(second).toEqual(first);
	});
	it("survives a deep chain without blowing the stack", () => {
		// Iterative Tarjan, not recursive: a 20k-node chain would overflow a
		// recursive implementation on most runtimes.
		//
		// The explicit timeout below is not a performance budget. Vitest
		// defaults to 5s, this took 5.3s on a loaded CI runner, and a
		// STACK-SAFETY check failing for being 6% slow tells nobody anything.
		// The assertions and the node count are untouched.
		const edges = Array.from({ length: 20_000 }, (_, i) =>
			edge(`n${i}`, `n${i + 1}`),
		);
		edges.push(edge("n20000", "n0"));

		const cycles = findImportCycles(edges);

		expect(cycles).toHaveLength(1);
		expect(cycles[0].members).toHaveLength(20_001);
	}, 20_000);
});
