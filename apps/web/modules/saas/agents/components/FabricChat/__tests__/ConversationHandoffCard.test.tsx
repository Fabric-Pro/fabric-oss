import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { conversations: { continueInNewChat: vi.fn() } },
	},
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { ConversationHandoffCard } = await import("../ConversationHandoffCard");

const renderCard = (reason: string) =>
	render(
		<ConversationHandoffCard
			parentConversationId="conv-1"
			reason={reason}
			summary="## Summary\nFound three flags."
			onContinue={vi.fn()}
		/>,
	);

describe("<ConversationHandoffCard>", () => {
	it.each([
		"Token budget exceeded: 512000/500000",
		"Iteration limit reached: 14/15",
	])(
		"calls a per-answer budget stop a step budget, not a context limit (%s)",
		(reason) => {
			const { container } = renderCard(reason);

			expect(
				screen.getByText("This answer ran out of its step budget"),
			).toBeInTheDocument();
			expect(
				screen.getByText(/Ask it to continue, narrow the question/),
			).toBeInTheDocument();
			expect(container.textContent).not.toMatch(/context limit/i);
			// The raw token counts are an implementation detail.
			expect(container.textContent).not.toContain(reason);
			expect(
				screen.getByRole("button", { name: /Continue in new chat/ }),
			).toBeInTheDocument();
		},
	);

	it("keeps the context-limit copy for any other reason", () => {
		renderCard("Conversation context limit reached");
		expect(
			screen.getByText("This conversation has reached its context limit"),
		).toBeInTheDocument();
	});
});
