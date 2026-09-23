import { renderHook } from "@testing-library/react";
import { SparklesIcon } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { useRoadmapActionItems } from "../roadmap-action-items";

const recommendItem = {
	id: "recommend-features",
	label: "Recommend Features from Context",
	icon: SparklesIcon,
	onSelect: vi.fn(),
	disabledReason: null,
};

vi.mock("../../recommendations/useRecommendActionItem", () => ({
	useRecommendActionItem: () => recommendItem,
}));
vi.mock("../../useRemoveAiRecommendedAction", () => ({
	useRemoveAiRecommendedAction: () => ({ item: null, overlay: null }),
}));

function itemsFor(roadmapPopulated: boolean) {
	const { result } = renderHook(() =>
		useRoadmapActionItems({
			projectId: "project-1",
			organizationId: "org-1",
			roadmapPopulated,
			roadmap: undefined,
			recommendationStarter: null,
			canUpdateProject: true,
		}),
	);
	return result.current.items.map((item) => item.id);
}

describe("useRoadmapActionItems", () => {
	it("offers the mature Recommend entry on a populated Roadmap (FR28)", () => {
		expect(itemsFor(true)).toEqual(["recommend-features"]);
	});

	it("leaves Recommend to the Start Building card on an unpopulated Roadmap", () => {
		expect(itemsFor(false)).toEqual([]);
	});
});
