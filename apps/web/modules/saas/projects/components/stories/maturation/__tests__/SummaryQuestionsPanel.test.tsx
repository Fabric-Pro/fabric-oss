/**
 * SummaryQuestionsPanel — Notes notebook.
 *
 * The notebook is human-owned: it saves on blur via `onSaveNotes` and must not
 * clobber in-progress typing when the parent re-renders with the same server
 * value. next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SummaryQuestionsPanel } from "../SummaryQuestionsPanel";
import type { DecisionLogThread } from "../types";

function openQuestion(
	id: string,
	summary: string,
	topic: string | null,
): DecisionLogThread {
	return {
		root: {
			id,
			status: "OPEN",
			summary,
			content: null,
			authorType: "AGENT",
			authorName: null,
			sourceProvenance: null,
			source: "AI_CONFIRMED",
			createdAt: new Date("2026-01-01"),
			impactedSection: "Open Questions (Discovery)",
			topic,
			questionId: `q_${id}`,
			decidedBy: null,
			cleanSpecPropagation: null,
			suggestedOptions: [],
		},
		replies: [],
	};
}

function renderPanel(
	overrides: Partial<Parameters<typeof SummaryQuestionsPanel>[0]> = {},
) {
	const onSaveNotes = vi.fn();
	const onAnswer = vi.fn();
	const utils = render(
		<SummaryQuestionsPanel
			summaryDigest="A digest."
			openQuestions={[]}
			workingNotesContent={null}
			onAnswer={onAnswer}
			onSaveNotes={onSaveNotes}
			answeringId={null}
			{...overrides}
		/>,
	);
	return { ...utils, onSaveNotes, onAnswer };
}

describe("SummaryQuestionsPanel — Notes", () => {
	it("saves the notebook text on blur", async () => {
		const user = userEvent.setup();
		const { onSaveNotes } = renderPanel();

		const notes = screen.getByPlaceholderText("notesPlaceholder");
		await user.click(notes);
		await user.type(notes, "Remember the edge case");
		await user.tab();

		expect(onSaveNotes).toHaveBeenCalledWith("Remember the edge case");
	});

	it("renders the summary digest as markdown, not raw syntax", () => {
		const { container } = renderPanel({
			summaryDigest: "**Decision** recorded",
		});
		const strong = container.querySelector("strong");
		expect(strong?.textContent).toBe("Decision");
		expect(container.textContent ?? "").not.toContain("**");
	});

	it("does not fire onSaveNotes on blur when the text is unchanged", async () => {
		const user = userEvent.setup();
		const { onSaveNotes } = renderPanel({
			workingNotesContent: "Existing note",
		});

		const notes = screen.getByPlaceholderText("notesPlaceholder");
		await user.click(notes);
		await user.tab();

		expect(onSaveNotes).not.toHaveBeenCalled();
	});

	it("does not clobber in-progress typing on a same-value re-render", async () => {
		const user = userEvent.setup();
		const { rerender } = renderPanel({ workingNotesContent: "seed" });

		const notes =
			screen.getByPlaceholderText<HTMLTextAreaElement>(
				"notesPlaceholder",
			);
		await user.clear(notes);
		await user.type(notes, "typing locally");

		// Parent re-renders with the SAME server value (e.g. another query tick).
		rerender(
			<SummaryQuestionsPanel
				summaryDigest="A digest."
				openQuestions={[]}
				workingNotesContent="seed"
				onAnswer={vi.fn()}
				onSaveNotes={vi.fn()}
				answeringId={null}
			/>,
		);

		expect(notes.value).toBe("typing locally");
	});

	it("re-seeds from the server value when it actually changes", () => {
		const { rerender } = renderPanel({ workingNotesContent: "first" });
		const notes =
			screen.getByPlaceholderText<HTMLTextAreaElement>(
				"notesPlaceholder",
			);
		expect(notes.value).toBe("first");

		rerender(
			<SummaryQuestionsPanel
				summaryDigest="A digest."
				openQuestions={[]}
				workingNotesContent="second"
				onAnswer={vi.fn()}
				onSaveNotes={vi.fn()}
				answeringId={null}
			/>,
		);

		expect(notes.value).toBe("second");
	});
});

describe("SummaryQuestionsPanel — topic grouping", () => {
	it("groups open questions under topic headers in taxonomy order", () => {
		renderPanel({
			openQuestions: [
				openQuestion("a", "Which toolkit?", "Tooling & Tech"),
				openQuestion("b", "What is in scope?", "Scope & Requirements"),
				openQuestion("c", "Custom or off-the-shelf?", "Tooling & Tech"),
			],
		});

		// Both topic headers render...
		const tooling = screen.getByRole("heading", { name: "Tooling & Tech" });
		const scope = screen.getByRole("heading", {
			name: "Scope & Requirements",
		});
		expect(tooling).toBeInTheDocument();
		expect(scope).toBeInTheDocument();

		// ...Scope sorts before Tooling per the fixed taxonomy order.
		expect(
			scope.compareDocumentPosition(tooling) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("falls back to a flat list when every question is untopiced", () => {
		renderPanel({
			openQuestions: [
				openQuestion("a", "First?", null),
				openQuestion("b", "Second?", null),
			],
		});
		// No topic header rendered; the questions still show.
		expect(
			screen.queryByRole("heading", { name: "Other" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("First?")).toBeInTheDocument();
		expect(screen.getByText("Second?")).toBeInTheDocument();
	});
});

describe("SummaryQuestionsPanel — AI answer recommendations (#7)", () => {
	function withSuggestions(
		id: string,
		summary: string,
		options: { text: string; justification: string }[],
	): DecisionLogThread {
		const q = openQuestion(id, summary, null);
		return {
			...q,
			root: { ...q.root, suggestedOptions: options },
		};
	}

	it("renders each option with its justification (FR-2)", () => {
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Security baseline." },
				]),
			],
		});
		expect(screen.getByText("Security baseline.")).toBeInTheDocument();
	});

	it("clicking a suggested option answers with AI_SUGGESTED", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
					{ text: "Optional", justification: "Gradual opt-in." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(screen.getByRole("button", { name: /Optional/ }));
		expect(onAnswer).toHaveBeenCalledWith("q_a", "Optional", {
			answerSource: "AI_SUGGESTED",
		});
	});

	// Was asserted as AI_EDITED until #1907. "Type your own" opens an EMPTY box, so
	// nothing is taken from the AI — that is a MANUAL answer, and AI_EDITED is now
	// reserved for a suggestion the PO opened and actually changed. Deliberate
	// contract change, not a stale assertion.
	it("typing your own over a suggestion answers with MANUAL", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(
			screen.getByRole("button", { name: "typeYourOwn" }),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "answerLabel" }),
			"Custom answer",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "answerSubmit" }),
		);
		expect(onAnswer).toHaveBeenCalledWith("q_a", "Custom answer", {
			summary: "",
			answerSource: "MANUAL",
		});
	});

	// next-intl is key-mocked, so every Edit control shares the accessible name
	// "editSuggestionAria" — index them rather than matching on the option text.
	function editControls() {
		return screen.getAllByRole("button", { name: "editSuggestionAria" });
	}

	it("Edit pre-fills the answer field with that suggestion's text (#1907 AC-4)", async () => {
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
					{ text: "Optional", justification: "Gradual opt-in." },
				]),
			],
		});

		// Second control => second option, proving Edit is per-suggestion.
		await userEvent.click(editControls()[1]);
		expect(
			screen.getByRole("textbox", { name: "answerLabel" }),
		).toHaveValue("Optional");
	});

	it("editing a suggestion and saving it unchanged records AI_SUGGESTED", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(editControls()[0]);
		await userEvent.click(
			screen.getByRole("button", { name: "answerSubmit" }),
		);
		expect(onAnswer).toHaveBeenCalledWith("q_a", "Yes", {
			summary: "",
			answerSource: "AI_SUGGESTED",
		});
	});

	it("editing a suggestion and changing the text records AI_EDITED", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(editControls()[0]);
		const box = screen.getByRole("textbox", { name: "answerLabel" });
		await userEvent.clear(box);
		await userEvent.type(box, "Yes, for admins only");
		await userEvent.click(
			screen.getByRole("button", { name: "answerSubmit" }),
		);
		expect(onAnswer).toHaveBeenCalledWith("q_a", "Yes, for admins only", {
			summary: "",
			answerSource: "AI_EDITED",
		});
	});

	it("clearing the field while editing blocks the save", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(editControls()[0]);
		await userEvent.clear(
			screen.getByRole("textbox", { name: "answerLabel" }),
		);
		expect(
			screen.getByRole("button", { name: "answerSubmit" }),
		).toBeDisabled();
		expect(onAnswer).not.toHaveBeenCalled();
	});

	it("cancelling an edit restores the suggestions and leaves the question open", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [
				withSuggestions("a", "Mandatory MFA?", [
					{ text: "Yes", justification: "Baseline." },
				]),
			],
			onAnswer,
		});

		await userEvent.click(editControls()[0]);
		await userEvent.click(screen.getByRole("button", { name: "cancel" }));

		expect(
			screen.queryByRole("textbox", { name: "answerLabel" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Baseline.")).toBeInTheDocument();
		expect(onAnswer).not.toHaveBeenCalled();
	});

	it("a question with no suggestion uses the plain manual flow (MANUAL)", async () => {
		const onAnswer = vi.fn();
		renderPanel({
			openQuestions: [openQuestion("a", "What is in scope?", null)],
			onAnswer,
		});

		await userEvent.click(
			screen.getByRole("button", { name: "answerLabel" }),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "answerLabel" }),
			"My answer",
		);
		await userEvent.click(
			screen.getByRole("button", { name: "answerSubmit" }),
		);
		expect(onAnswer).toHaveBeenCalledWith("q_a", "My answer", {
			summary: "",
			answerSource: "MANUAL",
		});
	});
});

describe("SummaryQuestionsPanel — Summary generating state (#1796)", () => {
	it("shows the generating spinner (not the empty state) while a summary is being produced", () => {
		renderPanel({ summaryDigest: null, isGenerating: true });
		expect(screen.getByText("digestGenerating")).toBeInTheDocument();
		expect(screen.queryByText("digestEmpty")).not.toBeInTheDocument();
	});

	it("shows the empty state only once settled with no digest", () => {
		renderPanel({ summaryDigest: null, isGenerating: false });
		expect(screen.getByText("digestEmpty")).toBeInTheDocument();
		expect(screen.queryByText("digestGenerating")).not.toBeInTheDocument();
	});

	it("shows a cached digest immediately with no spinner, even if isGenerating is true", () => {
		renderPanel({ summaryDigest: "Cached summary.", isGenerating: true });
		expect(screen.getByText("Cached summary.")).toBeInTheDocument();
		expect(screen.queryByText("digestGenerating")).not.toBeInTheDocument();
		expect(screen.queryByText("digestEmpty")).not.toBeInTheDocument();
	});
});
