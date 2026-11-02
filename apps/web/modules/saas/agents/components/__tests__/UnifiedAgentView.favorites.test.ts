import { expect, it } from "vitest";
import { isFavoritedAgent } from "../UnifiedAgentView";

it("excludes unstarred instances and keeps only favorited, pinned or featured agents", () => {
	const items = [
		{ id: "plain", _type: "instance" },
		{ id: "favorite", isFavorited: true },
		{ id: "pinned", isPinned: true },
		{ id: "featured", isFeatured: true },
	];
	expect(items.filter(isFavoritedAgent).map((item) => item.id)).toEqual([
		"favorite",
		"pinned",
		"featured",
	]);
});
