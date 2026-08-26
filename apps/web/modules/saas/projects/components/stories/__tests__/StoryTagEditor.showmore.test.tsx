import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { StoryTagEditor } from "../StoryTagEditor";

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

const tags = Array.from({ length: 10 }, (_, i) => ({
	id: `t${i}`,
	value: `tag-${i}`,
	createdById: "u1",
}));

const baseProps = {
	projectId: "p1",
	storyId: "s1",
	organizationId: null,
	currentUserId: "u1",
	canAddTags: true,
	canManageAllTags: true,
};

describe("StoryTagEditor maxVisible", () => {
	it("renders all tags when maxVisible is unset", () => {
		render(wrap(<StoryTagEditor {...baseProps} tags={tags} />));
		expect(screen.getByText("tag-9")).toBeInTheDocument();
		expect(screen.queryByText(/Show more/)).toBeNull();
	});

	it("collapses past maxVisible and toggles", async () => {
		render(
			wrap(<StoryTagEditor {...baseProps} tags={tags} maxVisible={8} />),
		);
		expect(screen.queryByText("tag-9")).toBeNull();
		// `expanded` is internal state — drive it with fireEvent (act-wrapped)
		// and assert with findBy; do NOT rerender (that would reset the instance).
		fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
		expect(await screen.findByText("tag-9")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Show less/ }),
		).toBeInTheDocument();
	});
});
