/**
 * Unit tests for ClarifyingQuestionCard — the in-chat answer card the AI
 * Assistant renders to ask a clarifying question (spec AC1–AC5, AC8).
 *
 * The card is pure presentational (no CopilotKit dependency), so these tests
 * render it directly and assert the answer/dismiss contract + degradation +
 * keyboard accelerators.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	ClarifyingQuestionCard,
	MAX_CUSTOM_ANSWER_LENGTH,
	normalizeClarifyingOptions,
} from "../ClarifyingQuestionCard";

const QUESTION = "Which auth method should the login flow use?";
const OPTIONS = ["Email magic links", "OAuth", "SAML SSO"];

function setup(
	props?: Partial<React.ComponentProps<typeof ClarifyingQuestionCard>>,
) {
	const onAnswer = vi.fn();
	const onDismiss = vi.fn();
	const utils = render(
		<ClarifyingQuestionCard
			question={QUESTION}
			options={OPTIONS}
			onAnswer={onAnswer}
			onDismiss={onDismiss}
			{...props}
		/>,
	);
	return { onAnswer, onDismiss, ...utils };
}

describe("normalizeClarifyingOptions", () => {
	it("trims, drops empties, dedupes (case-insensitive), and caps at 3", () => {
		expect(
			normalizeClarifyingOptions([
				"  Yes  ",
				"yes",
				"",
				"No",
				"Maybe",
				"Later",
			]),
		).toEqual(["Yes", "No", "Maybe"]);
	});

	it("returns [] for non-array / non-string input", () => {
		expect(normalizeClarifyingOptions(undefined)).toEqual([]);
		expect(normalizeClarifyingOptions("nope")).toEqual([]);
		expect(normalizeClarifyingOptions([1, 2, {}])).toEqual([]);
	});
});

describe("ClarifyingQuestionCard", () => {
	it("renders the question, the suggested options, and the custom affordance (AC2)", () => {
		setup();
		expect(screen.getByText(QUESTION)).toBeInTheDocument();
		for (const opt of OPTIONS) {
			expect(
				screen.getByRole("button", { name: new RegExp(opt) }),
			).toBeInTheDocument();
		}
		expect(
			screen.getByRole("button", { name: /type your own answer/i }),
		).toBeInTheDocument();
	});

	it("calls onAnswer with viaCustom=false when an option is clicked (AC3)", () => {
		const { onAnswer } = setup();
		fireEvent.click(screen.getByRole("button", { name: /OAuth/ }));
		expect(onAnswer).toHaveBeenCalledTimes(1);
		expect(onAnswer).toHaveBeenCalledWith({
			answer: "OAuth",
			viaCustom: false,
		});
		// Resolves to the answered state.
		expect(screen.getByText(/Answered:/)).toBeInTheDocument();
	});

	it("submits a custom answer with viaCustom=true (AC4)", () => {
		const { onAnswer } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: /type your own answer/i }),
		);
		const textarea = screen.getByLabelText(/type your own answer/i);
		fireEvent.change(textarea, { target: { value: "Passkeys" } });
		fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
		expect(onAnswer).toHaveBeenCalledWith({
			answer: "Passkeys",
			viaCustom: true,
		});
	});

	it("blocks an empty custom answer with a validation message (AC4 edge)", () => {
		const { onAnswer } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: /type your own answer/i }),
		);
		fireEvent.change(screen.getByLabelText(/type your own answer/i), {
			target: { value: "   " },
		});
		fireEvent.click(screen.getByRole("button", { name: /send answer/i }));
		expect(onAnswer).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				/Enter an answer, or pick one of the suggestions/i,
			),
		).toBeInTheDocument();
	});

	it("caps the custom answer length", () => {
		setup();
		fireEvent.click(
			screen.getByRole("button", { name: /type your own answer/i }),
		);
		const textarea = screen.getByLabelText(
			/type your own answer/i,
		) as HTMLTextAreaElement;
		expect(textarea.maxLength).toBe(MAX_CUSTOM_ANSWER_LENGTH);
	});

	it("calls onDismiss and shows the skipped state when dismissed (AC5)", () => {
		const { onDismiss } = setup();
		fireEvent.click(
			screen.getByRole("button", { name: /dismiss question/i }),
		);
		expect(onDismiss).toHaveBeenCalledTimes(1);
		expect(screen.getByText(/noted as an open item/i)).toBeInTheDocument();
	});

	it("degrades gracefully with zero options — still shows the question + custom field", () => {
		const { onAnswer } = setup({ options: [] });
		expect(screen.getByText(QUESTION)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /type your own answer/i }),
		).toBeInTheDocument();
		// No suggested-answer buttons.
		expect(
			screen.queryByRole("group", { name: /suggested answers/i }),
		).not.toBeInTheDocument();
		expect(onAnswer).not.toHaveBeenCalled();
	});

	it("hides the custom field when allowCustom is false", () => {
		setup({ allowCustom: false });
		expect(
			screen.queryByRole("button", { name: /type your own answer/i }),
		).not.toBeInTheDocument();
	});

	it("supports number-key (1) accelerator to choose the first option (AC8)", () => {
		const { onAnswer, container } = setup();
		const cardRoot = container.querySelector(
			'[role="group"]',
		) as HTMLElement;
		fireEvent.keyDown(cardRoot, { key: "1" });
		expect(onAnswer).toHaveBeenCalledWith({
			answer: "Email magic links",
			viaCustom: false,
		});
	});

	it("does not double-answer after a choice is made", () => {
		const { onAnswer } = setup();
		fireEvent.click(screen.getByRole("button", { name: /OAuth/ }));
		// The interactive options are gone; a second synthetic click can't fire.
		expect(
			screen.queryByRole("button", { name: /SAML SSO/ }),
		).not.toBeInTheDocument();
		expect(onAnswer).toHaveBeenCalledTimes(1);
	});
});
