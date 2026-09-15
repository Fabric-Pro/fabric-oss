import { describe, expect, it } from "vitest";
import { remapPmSyncOverrides } from "../change-item-schema";

describe("remapPmSyncOverrides", () => {
	it("shifts overrides left when an earlier item was already applied", () => {
		// Submitted items: 0 (already applied), 1 skip, 2 pushAnyway.
		const overrides = { 1: { skip: true }, 2: { pushAnyway: true } };
		// Retry filtering drops position 0, keeping 1 and 2.
		expect(remapPmSyncOverrides(overrides, [1, 2])).toEqual({
			0: { skip: true },
			1: { pushAnyway: true },
		});
	});

	it("returns an empty map for empty overrides", () => {
		expect(remapPmSyncOverrides({}, [0, 1, 2])).toEqual({});
	});

	it("drops overrides whose original position was filtered out", () => {
		const overrides = { 0: { skip: true }, 1: { pushAnyway: true } };
		expect(remapPmSyncOverrides(overrides, [1])).toEqual({
			0: { pushAnyway: true },
		});
	});

	it("is the identity when nothing was filtered", () => {
		const overrides = { 0: { skip: true }, 2: { pushAnyway: true } };
		expect(remapPmSyncOverrides(overrides, [0, 1, 2])).toEqual({
			0: { skip: true },
			2: { pushAnyway: true },
		});
	});

	it("accepts string keys as produced by the wire schema", () => {
		const overrides: Record<string, { skip?: boolean }> = {
			"2": { skip: true },
		};
		expect(remapPmSyncOverrides(overrides, [2])).toEqual({
			0: { skip: true },
		});
	});
});
