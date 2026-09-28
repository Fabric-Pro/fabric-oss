import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAssertionValues } from "../assertion-values";

const pairs = [
	...Array.from({ length: 17 }, (_, index) => ({
		actual: 1_000 + index,
		expected: 100 + index,
	})),
	...Array.from({ length: 17 }, (_, index) => ({
		actual: -(index + 0.25),
		expected: -(index + 0.75),
	})),
	...Array.from({ length: 17 }, (_, index) => ({
		actual: 1_000_000 + index,
		expected: 2_000_000 + index,
	})),
];

const assertions = [
	{ name: "strictEqual", run: strictEqual },
	{ name: "deepStrictEqual", run: deepStrictEqual },
	{ name: "equal", run: equal },
];

function failedAssertion(run: () => void): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw error;
	}
	throw new Error("The assertion unexpectedly passed");
}

describe("native Node assertion direction matrix", () => {
	it("covers 153 distinct failures across integers, decimals, and large values", () => {
		expect(pairs).toHaveLength(51);
		expect(assertions).toHaveLength(3);
		expect(
			new Set(
				pairs.map(({ actual, expected }) => `${actual}:${expected}`),
			).size,
		).toBe(51);
	});

	for (const { name, run } of assertions) {
		it.each(pairs)(
			`${name} extracts $actual and $expected in the right direction`,
			({ actual, expected }) => {
				const error = failedAssertion(() => run(actual, expected));
				const values = {
					expected: String(expected),
					actual: String(actual),
				};

				expect(parseAssertionValues(inspect(error))).toEqual(values);
				if (name !== "equal" && actual < 1_000_000) {
					expect(parseAssertionValues(error.message)).toEqual(values);
				}
			},
		);
	}
});
