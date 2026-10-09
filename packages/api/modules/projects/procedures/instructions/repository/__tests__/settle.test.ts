import { describe, expect, it } from "vitest";
import { inOrder } from "../settle";

const failure = (message: string, afterMs: number) =>
	new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(message)), afterMs),
	);
const value = <T>(result: T, afterMs: number) =>
	new Promise<T>((resolve) => setTimeout(() => resolve(result), afterMs));

describe("inOrder", () => {
	it("answers both values in declaration order", async () => {
		expect(await inOrder(value("a", 5), value(2, 1))).toEqual(["a", 2]);
	});

	it("throws the earlier-declared failure although the later one failed first", async () => {
		await expect(
			inOrder(failure("first", 20), failure("second", 1)),
		).rejects.toThrow("first");
	});

	it("throws the later-declared failure when the earlier one succeeds", async () => {
		await expect(
			inOrder(value("a", 1), failure("second", 1)),
		).rejects.toThrow("second");
	});

	it("waits for the slower step before throwing, so none is left running", async () => {
		let finished = false;
		const slow = value("a", 30).then((a) => {
			finished = true;
			return a;
		});
		await expect(inOrder(slow, failure("second", 1))).rejects.toThrow(
			"second",
		);
		expect(finished).toBe(true);
	});
});
