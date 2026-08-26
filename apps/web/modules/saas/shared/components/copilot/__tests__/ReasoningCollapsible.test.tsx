import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReasoningCollapsible } from "../ReasoningCollapsible";

// CopilotKit's <Markdown> renders react-markdown internally; for the tests we
// just need to confirm the rendered text contains our content. Mock it
// minimally to avoid pulling the full markdown pipeline.
vi.mock("@copilotkit/react-ui", () => ({
	Markdown: ({ content }: { content: string }) => (
		<div data-testid="markdown">{content}</div>
	),
}));

describe("ReasoningCollapsible", () => {
	it("renders 'Thinking · 4.2s' collapsed by default", () => {
		render(<ReasoningCollapsible text="hi" durationMs={4200} />);
		expect(screen.getByRole("button")).toHaveTextContent("Thinking · 4.2s");
		expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
	});

	it("renders just 'Thinking' when durationMs is undefined", () => {
		render(<ReasoningCollapsible text="hi" />);
		expect(screen.getByRole("button")).toHaveTextContent("Thinking");
		expect(screen.queryByRole("button")).not.toHaveTextContent("·");
	});

	it("renders just 'Thinking' when durationMs is NaN", () => {
		render(<ReasoningCollapsible text="hi" durationMs={Number.NaN} />);
		expect(screen.getByRole("button")).toHaveTextContent("Thinking");
		expect(screen.queryByRole("button")).not.toHaveTextContent("·");
	});

	it("click toggles aria-expanded and reveals markdown content", () => {
		render(
			<ReasoningCollapsible text="some reasoning" durationMs={1000} />,
		);
		const button = screen.getByRole("button");
		expect(button).toHaveAttribute("aria-expanded", "false");

		fireEvent.click(button);
		expect(button).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByTestId("markdown")).toHaveTextContent(
			"some reasoning",
		);

		fireEvent.click(button);
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
	});

	it("returns null for empty text", () => {
		const { container } = render(
			<ReasoningCollapsible text="" durationMs={1000} />,
		);
		expect(container.firstChild).toBeNull();
	});

	it("returns null for whitespace-only text", () => {
		const { container } = render(
			<ReasoningCollapsible text={"   \n  \t"} />,
		);
		expect(container.firstChild).toBeNull();
	});

	describe("with toolCalls", () => {
		it("returns null when text empty AND toolCalls empty", () => {
			const { container } = render(
				<ReasoningCollapsible text="" toolCalls={[]} />,
			);
			expect(container.firstChild).toBeNull();
		});

		it("renders 'Tools · N' when only toolCalls present (no thinking)", () => {
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "1",
							name: "write_document_local",
							status: "success",
							durationMs: 400,
						},
						{
							id: "2",
							name: "search_teams_messages",
							status: "success",
							durationMs: 800,
						},
					]}
				/>,
			);
			expect(screen.getByRole("button")).toHaveTextContent("Tools · 2");
		});

		it("renders 'Thinking & Tools · 4.2s' when both present", () => {
			render(
				<ReasoningCollapsible
					text="some reasoning"
					durationMs={4200}
					toolCalls={[
						{
							id: "1",
							name: "write_document_local",
							status: "success",
							durationMs: 400,
						},
					]}
				/>,
			);
			expect(screen.getByRole("button")).toHaveTextContent(
				"Thinking & Tools · 4.2s",
			);
		});

		it("renders 'Thinking · 4.2s' when toolCalls undefined", () => {
			render(
				<ReasoningCollapsible
					text="some reasoning"
					durationMs={4200}
				/>,
			);
			expect(screen.getByRole("button")).toHaveTextContent(
				"Thinking · 4.2s",
			);
			expect(screen.getByRole("button")).not.toHaveTextContent("Tools");
		});

		it("expanded body shows thinking + tools sections in order", () => {
			render(
				<ReasoningCollapsible
					text="my thoughts"
					durationMs={1000}
					toolCalls={[
						{
							id: "1",
							name: "write_document_local",
							status: "success",
							durationMs: 400,
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			expect(screen.getByTestId("markdown")).toHaveTextContent(
				"my thoughts",
			);
			const rows = screen.getAllByTestId("tool-call-row");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toHaveTextContent("write_document_local");
		});

		it("renders inline-confirmation pending row with clock and 'awaiting' trailing", () => {
			// Backend semantic (chat-node.ts post-confirmation contract):
			// write_document_local and apply_document_patches stay `pending`
			// in state.toolCallsByTurn until the user accepts the
			// confirm_changes modal. Renderer must NOT spin Loader2 for these
			// names (it would lie "in flight" while the agent is parked,
			// waiting for the human) — render a static Clock + "awaiting"
			// affordance instead. See AWAITING_CONFIRMATION_TOOLS in
			// ReasoningCollapsible.tsx.
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "1",
							name: "apply_document_patches",
							status: "pending",
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			const row = screen.getByTestId("tool-call-row");
			expect(row).toHaveAttribute("data-tool-status", "pending");
			expect(row).toHaveAttribute(
				"data-pending-kind",
				"awaiting-confirmation",
			);
			expect(row).toHaveTextContent("apply_document_patches");
			expect(row).toHaveTextContent("awaiting");
			expect(row).not.toHaveTextContent("…");
			expect(row).toHaveAttribute(
				"title",
				"apply_document_patches — awaiting your confirmation",
			);
		});

		it("renders in-flight pending row with spinner and ellipsis trailing", () => {
			// Tools NOT in AWAITING_CONFIRMATION_TOOLS represent genuine
			// server-side work in progress (e.g. search_documents,
			// write_document_asset, MCP gateway calls). They keep the
			// original animated Loader2 + "…" rendering so the user sees a
			// true "in flight" affordance and distinguishes them from the
			// confirmation-parked entries above.
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "1",
							name: "search_documents",
							status: "pending",
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			const row = screen.getByTestId("tool-call-row");
			expect(row).toHaveAttribute("data-tool-status", "pending");
			expect(row).toHaveAttribute("data-pending-kind", "in-flight");
			expect(row).toHaveTextContent("search_documents");
			expect(row).toHaveTextContent("…");
			expect(row).not.toHaveTextContent("awaiting");
			expect(row).toHaveAttribute("title", "Calling search_documents…");
		});

		it("renders success tool row with duration", () => {
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "1",
							name: "write_document_local",
							status: "success",
							durationMs: 1234,
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			const row = screen.getByTestId("tool-call-row");
			expect(row).toHaveAttribute("data-tool-status", "success");
			expect(row).toHaveTextContent("1.2s");
		});

		it("renders error tool row with error message in title", () => {
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "1",
							name: "apply_document_patches",
							status: "error",
							durationMs: 200,
							errorMessage: "anchor not found",
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			const row = screen.getByTestId("tool-call-row");
			expect(row).toHaveAttribute("data-tool-status", "error");
			expect(row).toHaveAttribute(
				"title",
				"apply_document_patches: anchor not found",
			);
		});

		it("renders multiple rows preserving order", () => {
			render(
				<ReasoningCollapsible
					text=""
					toolCalls={[
						{
							id: "a",
							name: "search_teams_messages",
							status: "success",
							durationMs: 100,
						},
						{
							id: "b",
							name: "search_slack_messages",
							status: "pending",
						},
						{
							id: "c",
							name: "write_document_local",
							status: "error",
							durationMs: 50,
							errorMessage: "boom",
						},
					]}
				/>,
			);
			fireEvent.click(screen.getByRole("button"));
			const rows = screen.getAllByTestId("tool-call-row");
			expect(rows.map((r) => r.getAttribute("data-tool-status"))).toEqual(
				["success", "pending", "error"],
			);
		});
	});

	describe("inProgress spinner", () => {
		// The header label ("Thinking · 8.2s") is informative but its duration
		// updates in discrete jumps, which reads as static/jumpy rather than
		// "working". A live spinner next to the label gives continuous motion
		// while the turn is still generating. See `inProgress` in
		// ReasoningCollapsible.tsx (driven by CopilotAssistantMessage's
		// isCurrentMessage && (isLoading || isGenerating) && !content).
		it("shows a live spinner next to the label when inProgress", () => {
			render(
				<ReasoningCollapsible
					text="thinking hard"
					durationMs={8200}
					inProgress
				/>,
			);
			// Duration label is still present…
			expect(screen.getByRole("button")).toHaveTextContent(
				"Thinking · 8.2s",
			);
			// …plus a spinner so the trace reads as active motion.
			expect(
				screen.getByTestId("reasoning-inprogress-spinner"),
			).toBeInTheDocument();
		});

		it("shows the spinner for a tools-only in-progress turn", () => {
			render(
				<ReasoningCollapsible
					text=""
					inProgress
					toolCalls={[
						{
							id: "1",
							name: "search_teams_messages",
							status: "pending",
						},
					]}
				/>,
			);
			expect(
				screen.getByTestId("reasoning-inprogress-spinner"),
			).toBeInTheDocument();
		});

		it("hides the spinner for a completed turn (inProgress omitted)", () => {
			render(
				<ReasoningCollapsible text="done thinking" durationMs={8200} />,
			);
			expect(
				screen.queryByTestId("reasoning-inprogress-spinner"),
			).not.toBeInTheDocument();
		});

		it("hides the spinner when inProgress is explicitly false", () => {
			render(
				<ReasoningCollapsible
					text="done thinking"
					durationMs={8200}
					inProgress={false}
				/>,
			);
			expect(
				screen.queryByTestId("reasoning-inprogress-spinner"),
			).not.toBeInTheDocument();
		});
	});
});
