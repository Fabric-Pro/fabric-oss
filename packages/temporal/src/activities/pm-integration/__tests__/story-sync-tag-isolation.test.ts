import { describe, expect, it } from "vitest";
import { pmLabelValues } from "../story-sync";

describe("PM sync isolation — custom tags never leak", () => {
	it("pmLabelValues returns ONLY labels, never tag values", () => {
		const story = {
			labels: ["status::in-progress"],
			// a tag the helper must structurally ignore
			tags: [
				{ id: "t1", value: "secret-internal-tag", createdById: null },
			],
		};
		const result = pmLabelValues(story as { labels: string[] });
		expect(result).toEqual(["status::in-progress"]);
		expect(JSON.stringify(result)).not.toContain("secret-internal-tag");
	});

	it("returns [] when labels is null/undefined", () => {
		expect(pmLabelValues({ labels: null })).toEqual([]);
		expect(pmLabelValues({})).toEqual([]);
	});
});
