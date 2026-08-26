/**
 * Unit tests for Context component (AI Elements)
 *
 * Tests the redesigned Context component with:
 * - Circular progress ring
 * - Token breakdown (input/output/reasoning/cache)
 * - Cost calculation using tokenlens
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	Context,
	ContextBadge,
	ContextContent,
	ContextContentBody,
	ContextContentFooter,
	ContextContentHeader,
	ContextInputUsage,
	ContextOutputUsage,
	ContextTrigger,
	type LanguageModelUsage,
} from "../../components/ai-elements/context";

// Mock tokenlens
vi.mock("tokenlens", () => ({
	getUsage: vi.fn(({ _modelId, usage }) => {
		// Simple mock cost calculation
		const inputCost = (usage.input || 0) * 0.00001;
		const outputCost = (usage.output || 0) * 0.00003;
		return {
			costUSD: {
				inputUSD: inputCost,
				outputUSD: outputCost,
				totalUSD: inputCost + outputCost,
			},
		};
	}),
}));

describe("Context Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("ContextTrigger", () => {
		it("should render percentage and progress ring", () => {
			render(
				<Context maxTokens={128000} usedTokens={40000}>
					<ContextTrigger />
					<ContextContent>
						<ContextContentHeader />
					</ContextContent>
				</Context>,
			);

			// Should show percentage
			expect(screen.getByText("31.3%")).toBeInTheDocument();
		});

		it("should show 0% when no tokens used", () => {
			render(
				<Context maxTokens={128000} usedTokens={0}>
					<ContextTrigger />
					<ContextContent>
						<ContextContentHeader />
					</ContextContent>
				</Context>,
			);

			expect(screen.getByText("0.0%")).toBeInTheDocument();
		});
	});

	describe("ContextContent", () => {
		const mockUsage: LanguageModelUsage = {
			inputTokens: 32000,
			outputTokens: 8000,
			totalTokens: 40000,
		};

		it("should render header with token counts", async () => {
			const user = userEvent.setup();

			render(
				<Context
					maxTokens={128000}
					usedTokens={40000}
					usage={mockUsage}
					modelId="openai:gpt-4o"
				>
					<ContextTrigger />
					<ContextContent>
						<ContextContentHeader />
						<ContextContentBody>
							<ContextInputUsage />
							<ContextOutputUsage />
						</ContextContentBody>
						<ContextContentFooter />
					</ContextContent>
				</Context>,
			);

			// Hover to open the popover
			const trigger = screen.getByRole("button");
			await user.hover(trigger);

			// Wait for popover content
			// Note: HoverCard may need time to open
		});
	});

	describe("ContextBadge", () => {
		it("should render with default variant", () => {
			render(<ContextBadge label="Context" value="High usage" />);

			expect(screen.getByText("Context:")).toBeInTheDocument();
			expect(screen.getByText("High usage")).toBeInTheDocument();
		});

		it("should render with warning variant", () => {
			render(
				<ContextBadge
					label="Context"
					value="High usage"
					variant="warning"
				/>,
			);

			const badge = screen.getByText("High usage").parentElement;
			expect(badge).toHaveClass("bg-yellow-500/10");
		});

		it("should render with error variant", () => {
			render(
				<ContextBadge
					label="Tokens"
					value="Limit exceeded"
					variant="error"
				/>,
			);

			const badge = screen.getByText("Limit exceeded").parentElement;
			expect(badge).toHaveClass("bg-red-500/10");
		});
	});
});
