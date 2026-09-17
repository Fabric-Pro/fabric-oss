import { describe, expect, it } from "vitest";
import { computeSnapshotDigest } from "../src/manifest";

describe("computeSnapshotDigest", () => {
	it("is order-independent and changes when any hash changes", async () => {
		const a = await computeSnapshotDigest([
			{ path: "b.md", sha256: "22" },
			{ path: "a.md", sha256: "11" },
		]);
		const b = await computeSnapshotDigest([
			{ path: "a.md", sha256: "11" },
			{ path: "b.md", sha256: "22" },
		]);
		const c = await computeSnapshotDigest([
			{ path: "a.md", sha256: "11" },
			{ path: "b.md", sha256: "23" },
		]);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});
});
