import { describe, expect, it } from "vitest";
import { runDrainingPool } from "../draining-pool";

describe("runDrainingPool", () => {
	it("does not mistake an undefined item for the end of the queue", async () => {
		const seen: Array<number | undefined> = [];

		await runDrainingPool([undefined, 1], 1, async (item) => {
			seen.push(item);
		});

		expect(seen).toEqual([undefined, 1]);
	});
});
