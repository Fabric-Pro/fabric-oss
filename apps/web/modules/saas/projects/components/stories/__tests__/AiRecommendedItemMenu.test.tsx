import { QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aiApi, renderable } from "./ai-recommended-test-utils";

vi.mock("next-intl", async (importActual) => importActual());
vi.mock("@shared/lib/orpc-query-utils", async () =>
	(await import("./ai-recommended-test-utils")).orpcQueryUtilsMock(),
);
vi.mock("@shared/lib/orpc-client", async () =>
	(await import("./ai-recommended-test-utils")).orpcClientMock(),
);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AiRecommendedItemMenu } from "../AiRecommendedItemMenu";

const props = {
	projectId: "project-1",
	storyId: "story-1",
	identifier: "F-12",
};

describe("AiRecommendedItemMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		aiApi.protect.mockResolvedValue({
			protectedAt: new Date(),
			protectedById: "user-1",
			alreadyProtected: false,
		});
	});

	it("protects the item and refreshes what reads protection", async () => {
		const user = userEvent.setup();
		const queryClient = new QueryClient();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		render(
			renderable(
				<AiRecommendedItemMenu {...props} protectedAt={null} />,
				queryClient,
			),
		);

		await user.click(
			screen.getByRole("button", { name: "More actions for F-12" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "Protect Work Item" }),
		);

		await waitFor(() =>
			expect(aiApi.protect).toHaveBeenCalledWith({
				projectId: "project-1",
				storyId: "story-1",
			}),
		);
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: ["capability-gates", "project-1"],
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["projects.aiRecommended.listBatches"],
		});
		// A protected item leaves the batch's removal preview.
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["projects.aiRecommended.previewBatch"],
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["projects.stories.get"],
		});
	});

	it("shows a protected item as a disabled, checked state with no action", async () => {
		const user = userEvent.setup();
		render(
			renderable(
				<AiRecommendedItemMenu
					{...props}
					protectedAt="2026-09-01T00:00:00.000Z"
				/>,
			),
		);

		await user.click(
			screen.getByRole("button", { name: "More actions for F-12" }),
		);
		const state = await screen.findByRole("menuitemcheckbox", {
			name: "Protected from batch removal",
		});
		expect(state).toHaveAttribute("aria-checked", "true");
		expect(state).toHaveAttribute("aria-disabled", "true");
		expect(
			screen.queryByRole("menuitem", { name: "Protect Work Item" }),
		).not.toBeInTheDocument();
	});
});
