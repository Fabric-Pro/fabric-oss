import { describe, expect, it } from "vitest";
import { groupHighlightsByRelease } from "./group-highlights";

const h = (title: string, extra: Record<string, unknown> = {}) => ({
	title,
	description: "d",
	...extra,
});

describe("groupHighlightsByRelease", () => {
	it("groups by release metadata and sorts newest-first", () => {
		const groups = groupHighlightsByRelease([
			h("a", { releaseTag: "v1.3.4", repoFullName: "acme/web" }),
			h("b", { releaseTag: "v1.3.7", repoFullName: "acme/web" }),
			h("c", { releaseTag: "v1.3.4", repoFullName: "acme/web" }),
		]);
		expect(groups.map((g) => g.tag)).toEqual(["v1.3.7", "v1.3.4"]);
		expect(groups[1].items.map((i) => i.title)).toEqual(["a", "c"]);
	});

	it("keeps same tag from different repos as separate groups", () => {
		const groups = groupHighlightsByRelease([
			h("a", { releaseTag: "v1.0.0", repoFullName: "acme/web" }),
			h("b", { releaseTag: "v1.0.0", repoFullName: "acme/api" }),
		]);
		expect(groups).toHaveLength(2);
	});

	it("falls back to parsing prUrl when metadata is absent (legacy)", () => {
		const groups = groupHighlightsByRelease([
			h("a", { prUrl: "https://github.com/acme/web/releases/v1.3.7" }),
			h("b", {
				prUrl: "https://github.com/acme/web/releases/tag/v1.3.4",
			}),
		]);
		expect(groups.map((g) => g.tag)).toEqual(["v1.3.7", "v1.3.4"]);
	});

	it("sorts non-semver and version-less groups last, never drops items", () => {
		const groups = groupHighlightsByRelease([
			h("x"),
			h("y", { releaseTag: "nightly", repoFullName: "acme/web" }),
			h("z", { releaseTag: "v2.0.0", repoFullName: "acme/web" }),
		]);
		expect(groups[0].tag).toBe("v2.0.0");
		expect(groups.at(-1)?.tag).toBeNull();
		expect(groups.flatMap((g) => g.items)).toHaveLength(3);
	});

	it("returns [] and never throws for malformed (non-array) input", () => {
		// `highlights` comes from an unvalidated Prisma Json? column; guard against
		// undefined / non-array so the email + detail modal degrade instead of crash.
		expect(() =>
			groupHighlightsByRelease(undefined as never),
		).not.toThrow();
		expect(groupHighlightsByRelease(undefined as never)).toEqual([]);
		expect(() => groupHighlightsByRelease({} as never)).not.toThrow();
		expect(groupHighlightsByRelease({} as never)).toEqual([]);
	});
});
