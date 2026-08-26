import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StoryTagEditor } from "../StoryTagEditor";

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				tags: {
					list: {
						queryOptions: () => ({
							queryKey: ["t"],
							queryFn: async () => ({ tags: [] }),
						}),
						queryKey: () => ["t"],
					},
				},
				list: { queryKey: () => ["list"] },
				get: { queryKey: () => ["get"] },
			},
		},
	},
}));
vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { stories: { tags: { add: vi.fn(), remove: vi.fn() } } },
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQuery: () => ({ data: { tags: [] } }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

const baseProps = {
	projectId: "p1",
	storyId: "s1",
	organizationId: null,
	tags: [
		{ id: "t1", value: "api", createdById: "me" },
		{ id: "t2", value: "billing", createdById: "other" },
	],
	currentUserId: "me",
	canAddTags: true,
	canManageAllTags: false,
};

describe("StoryTagEditor", () => {
	it("renders every tag value", () => {
		render(<StoryTagEditor {...baseProps} />);
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.getByText("billing")).toBeInTheDocument();
	});

	it("hides the add control when the caller cannot add tags", () => {
		render(<StoryTagEditor {...baseProps} canAddTags={false} />);
		expect(
			screen.queryByRole("button", { name: /add tag/i }),
		).not.toBeInTheDocument();
	});

	it("shows a remove control only for tags the caller may remove", () => {
		// creator of 'api' = me → removable; 'billing' created by other, not admin → not
		render(<StoryTagEditor {...baseProps} />);
		expect(
			screen.getByRole("button", { name: /remove tag api/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /remove tag billing/i }),
		).not.toBeInTheDocument();
	});

	it("hides the remove control from a creator who can no longer add (demoted)", () => {
		render(<StoryTagEditor {...baseProps} canAddTags={false} />);
		expect(
			screen.queryByRole("button", { name: /remove tag api/i }),
		).not.toBeInTheDocument();
	});

	it("shows an inline error for an over-length tag (no mutation)", () => {
		render(<StoryTagEditor {...baseProps} />);
		// open the popover, type a 51-char value, submit via Enter
		fireEvent.click(screen.getByRole("button", { name: /add tag/i }));
		const input = screen.getByPlaceholderText(/add tag/i);
		fireEvent.change(input, { target: { value: "a".repeat(51) } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(screen.getByRole("alert")).toHaveTextContent(/at most 50/i);
	});
});
