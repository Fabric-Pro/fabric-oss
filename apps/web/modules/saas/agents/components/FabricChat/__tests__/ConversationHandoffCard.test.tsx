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

	it.each(["allowance_exhausted", "finalization_unavailable"] as const)(
		"offers no new chat for a token-allowance stop and says the user can continue here (%s)",
		(stopReason) => {
			const { container } = render(
				<ConversationHandoffCard
					parentConversationId="conv-1"
					// Even a reason that reads like a step-budget stop: the
					// structured kind decides, never the wording.
					reason="Token budget exceeded: 512000/500000"
					summary=""
					budgetStop={{
						kind: "token_allowance",
						allowance: 500_000,
						measured: 470_000,
						outstanding: 25_000,
						enforcement: "ENFORCED",
						stopReason,
					}}
					onContinue={vi.fn()}
				/>,
			);

			expect(
				screen.getByText("This answer used its token allowance"),
			).toBeInTheDocument();
			expect(
				screen.getByText(/ask it to continue in this chat/),
			).toBeInTheDocument();
			expect(screen.queryByRole("button")).toBeNull();
			expect(container.textContent).not.toMatch(/new chat|fresh chat/i);
			// No token counts: the copy says what happened, not the numbers.
			expect(container.textContent).not.toMatch(/\d{3},?\d{3}/);
		},
	);

	it.each([
		["allowance_exhausted", /was written from what was found/],
		["finalization_unavailable", /couldn't write a full reply/],
	] as const)(
		"says whether the reply is a written answer or a list of findings (%s)",
		(stopReason, copy) => {
			render(
				<ConversationHandoffCard
					parentConversationId="conv-1"
					reason=""
					summary=""
					budgetStop={{
						kind: "token_allowance",
						allowance: 500_000,
						measured: 470_000,
						outstanding: 25_000,
						enforcement: "ENFORCED",
						stopReason,
					}}
					onContinue={vi.fn()}
				/>,
			);

			expect(screen.getByText(copy)).toBeInTheDocument();
			// The static list has causes other than the allowance (a reply
			// that came back too short, or failed), so it blames none.
			if (stopReason === "finalization_unavailable") {
				expect(
					screen.queryByText(/enough tokens|token allowance left/i),
				).toBeNull();
			}
		},
	);
});
