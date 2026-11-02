import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (file: string) =>
	readFileSync(
		`modules/saas/projects/components/stories/${file}`,
		"utf8",
	).replace(/\s/g, "");
describe("roadmap integration with the component-tested search lifecycle", () => {
	it("passes board data to the search hook and feeds the result into matching", () => {
		const roadmap = source("StoriesRoadmap.tsx");
		expect(roadmap).toContain(
			"useDescriptionSearch(projectId,organizationId,roadmapFilters.q,storiesData?.stories,",
		);
		expect(roadmap).toContain(
			"constdescriptionMatches=descriptionSearch.matches;",
		);
		expect(roadmap).toContain(
			"<DescriptionSearchStatusstatus={descriptionSearch.status}retry={descriptionSearch.retry}/>",
		);
	});
	it.each([
		["StoryCard.tsx", "conflictDialogOpen", "conflictDetail"],
		["StoriesRoadmap.tsx", "weaveDialogOpen", "weaveDetail"],
	])(
		"connects %s detail errors and loading feedback",
		(file, open, detail) => {
			const component = source(file);
			expect(component).toContain(
				`useDetailLoadFeedback(${open},${detail},`,
			);
			expect(component).toContain(`${open}&&${detail}.isFetching&&(`);
		},
	);
});
