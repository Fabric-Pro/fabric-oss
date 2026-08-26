import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StoryAttachmentsButton } from "../StoryAttachmentsButton";

const { listAttachments } = vi.hoisted(() => ({
	listAttachments: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));

const wrap = (ui: ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const story = {
	id: "s1",
	identifier: "F-1",
	description: "",
} as unknown as UserStory;
const props = {
	story,
	projectId: "p1",
	organizationId: "o1" as string | null,
	canEdit: true,
};

beforeEach(() => {
	listAttachments.mockReset().mockResolvedValue({ attachments: [] });
});

describe("StoryAttachmentsButton", () => {
	it("fetches the count eagerly and shows no badge at zero", async () => {
		render(wrap(<StoryAttachmentsButton {...props} />));
		await waitFor(() => expect(listAttachments).toHaveBeenCalled());
		// zero attachments → no numeric badge
		expect(screen.queryByText("0")).not.toBeInTheDocument();
	});

	it("shows a numeric badge equal to the attachment count", async () => {
		listAttachments.mockResolvedValue({ attachments: [{}, {}, {}] });
		render(wrap(<StoryAttachmentsButton {...props} />));
		expect(await screen.findByText("3")).toBeInTheDocument();
	});

	it("caps the badge at 99+", async () => {
		listAttachments.mockResolvedValue({
			attachments: Array.from({ length: 101 }, () => ({})),
		});
		render(wrap(<StoryAttachmentsButton {...props} />));
		expect(await screen.findByText("99+")).toBeInTheDocument();
	});

	it("clicking still opens the attachments sheet with a badge present", async () => {
		listAttachments.mockResolvedValue({ attachments: [{}, {}] });
		render(wrap(<StoryAttachmentsButton {...props} />));
		await screen.findByText("2");
		fireEvent.click(screen.getByRole("button", { name: /Attachments/ }));
		expect(
			await screen.findByText("Attachments — F-1"),
		).toBeInTheDocument();
	});

	it("opens the attachments panel and fetches on click", async () => {
		render(wrap(<StoryAttachmentsButton {...props} />));
		fireEvent.click(screen.getByRole("button", { name: "Attachments" }));
		// Panel opened (title rendered) — proves the Sheet mounted AttachmentsTab.
		expect(
			await screen.findByText("Attachments — F-1"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(listAttachments).toHaveBeenCalledWith({
				projectId: "p1",
				userStoryId: "s1",
				organizationId: "o1",
			}),
		);
	});
});
