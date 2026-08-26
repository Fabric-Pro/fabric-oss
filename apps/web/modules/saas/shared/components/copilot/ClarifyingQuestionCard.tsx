"use client";

/**
 * ClarifyingQuestionCard — the in-chat answer card the AI Assistant uses to ask
 * a clarifying / follow-up question with a few suggested answers plus a
 * "type your own" escape hatch.
 *
 * It renders inline in the CopilotKit chat stream (NOT a blocking modal) as the
 * UI of a `useCopilotAction({ name: "ask_clarifying_question",
 * renderAndWaitForResponse })` registration. Choosing an option (or submitting a
 * custom answer) resolves the action so the agent continues with that answer.
 * Dismissing resolves it as "not answered" so the agent records the question as
 * an open item and pauses (see useClarifyingQuestionAction).
 *
 * Design: design-token surfaces only (no hardcoded hex, no glassmorphism), an
 * editorial uppercase label with the thin red bar, calm advisory copy
 * (standards/ai/ai-copy-tone.md — always dismissible, no "best/optimal/
 * required"). Accessibility: options are a labeled button group with roving
 * arrow-key focus, Enter/Space/click to choose, and number-key (1–3)
 * accelerators that are inert while the custom field is focused; the question is
 * announced politely via a status region without stealing focus.
 */

import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	CheckCircle2Icon,
	HelpCircleIcon,
	PencilLineIcon,
	XIcon,
} from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";

/** Max length of a typed custom answer (guards prompt-injection / context bloat). */
export const MAX_CUSTOM_ANSWER_LENGTH = 500;
/** Max suggested options the card will render (extras are ignored). */
const MAX_CLARIFYING_OPTIONS = 3;

type ClarifyingQuestionAnswer = {
	answer: string;
	/** true when typed in the custom field, false when a suggested option was clicked. */
	viaCustom: boolean;
};

export interface ClarifyingQuestionCardProps {
	question: string;
	/** Suggested answers from the AI (0–3 are rendered; the custom field is always available). */
	options?: string[];
	/** When false, hides the "type your own answer" affordance. Defaults to true. */
	allowCustom?: boolean;
	/** Called once when the user answers (option click or custom submit). */
	onAnswer: (answer: ClarifyingQuestionAnswer) => void;
	/** Called once when the user dismisses without answering. */
	onDismiss: () => void;
}

/** Normalize agent-supplied options: trim, drop empties, dedupe, cap at MAX. */
export function normalizeClarifyingOptions(options: unknown): string[] {
	if (!Array.isArray(options)) {
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of options) {
		if (typeof raw !== "string") {
			continue;
		}
		const trimmed = raw.trim();
		if (!trimmed) {
			continue;
		}
		const key = trimmed.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(trimmed);
		if (out.length >= MAX_CLARIFYING_OPTIONS) {
			break;
		}
	}
	return out;
}

type Resolution =
	| { kind: "answered"; answer: string }
	| { kind: "dismissed" }
	| null;

export function ClarifyingQuestionCard({
	question,
	options,
	allowCustom = true,
	onAnswer,
	onDismiss,
}: ClarifyingQuestionCardProps) {
	const normalizedOptions = useMemo(
		() => normalizeClarifyingOptions(options),
		[options],
	);
	const [resolution, setResolution] = useState<Resolution>(null);
	const [customOpen, setCustomOpen] = useState(false);
	const [customValue, setCustomValue] = useState("");
	const [customError, setCustomError] = useState<string | null>(null);

	const questionId = useId();
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const customRef = useRef<HTMLTextAreaElement | null>(null);

	const submitOption = useCallback(
		(answer: string) => {
			if (resolution) {
				return;
			}
			setResolution({ kind: "answered", answer });
			onAnswer({ answer, viaCustom: false });
		},
		[resolution, onAnswer],
	);

	const submitCustom = useCallback(() => {
		if (resolution) {
			return;
		}
		const trimmed = customValue.trim();
		if (!trimmed) {
			setCustomError("Enter an answer, or pick one of the suggestions.");
			return;
		}
		setResolution({ kind: "answered", answer: trimmed });
		onAnswer({ answer: trimmed, viaCustom: true });
	}, [resolution, customValue, onAnswer]);

	const dismiss = useCallback(() => {
		if (resolution) {
			return;
		}
		setResolution({ kind: "dismissed" });
		onDismiss();
	}, [resolution, onDismiss]);

	// Number-key (1–3) accelerators at the card level — inert while the custom
	// textarea is focused so digits are typed, not captured.
	const handleCardKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (resolution) {
				return;
			}
			if (
				customRef.current &&
				document.activeElement === customRef.current
			) {
				return;
			}
			if (e.key >= "1" && e.key <= "9") {
				const index = Number(e.key) - 1;
				if (index < normalizedOptions.length) {
					e.preventDefault();
					submitOption(normalizedOptions[index]);
				}
			}
		},
		[resolution, normalizedOptions, submitOption],
	);

	// Roving arrow-key focus across the option buttons (moves focus only; does
	// not choose — Enter/Space/click chooses). Keeps a single, predictable
	// keyboard model for the group.
	const handleOptionKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
			if (e.key === "ArrowDown" || e.key === "ArrowRight") {
				e.preventDefault();
				const next = (index + 1) % normalizedOptions.length;
				optionRefs.current[next]?.focus();
			} else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
				e.preventDefault();
				const prev =
					(index - 1 + normalizedOptions.length) %
					normalizedOptions.length;
				optionRefs.current[prev]?.focus();
			}
		},
		[normalizedOptions.length],
	);

	if (resolution?.kind === "answered") {
		return (
			<div className="rounded-lg border border-border bg-muted/30 p-3">
				<div className="flex items-start gap-2">
					<CheckCircle2Icon
						className="mt-0.5 size-4 shrink-0 text-secondary"
						aria-hidden="true"
					/>
					<p className="text-sm text-foreground">
						<span className="text-muted-foreground">Answered:</span>{" "}
						{resolution.answer}
					</p>
				</div>
			</div>
		);
	}

	if (resolution?.kind === "dismissed") {
		return (
			<div className="rounded-lg border border-border bg-muted/30 p-3">
				<p className="text-sm text-muted-foreground">
					Question skipped — noted as an open item for review.
				</p>
			</div>
		);
	}

	return (
		// biome-ignore lint/a11y/useSemanticElements: a labelled region grouping the question + answer controls
		<div
			role="group"
			aria-labelledby={questionId}
			onKeyDown={handleCardKeyDown}
			className="rounded-lg border border-border bg-card p-4 shadow-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
		>
			{/* Politely announce the new question without stealing focus. */}
			<output className="sr-only">
				The assistant is asking a clarifying question.
			</output>

			<div className="mb-2 flex items-start justify-between gap-2">
				<span className="inline-flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
					<span
						className="h-3 w-0.5 rounded-full bg-primary"
						aria-hidden="true"
					/>
					Clarifying question
				</span>
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground"
					onClick={dismiss}
					aria-label="Dismiss question"
				>
					<XIcon className="size-3.5" />
				</Button>
			</div>

			<p
				id={questionId}
				className="mb-3 flex items-start gap-2 text-sm font-medium text-foreground"
			>
				<HelpCircleIcon
					className="mt-0.5 size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				<span>{question}</span>
			</p>

			{normalizedOptions.length > 0 && (
				// biome-ignore lint/a11y/useSemanticElements: a labelled group of answer buttons (not a radiogroup — choosing submits)
				<div
					role="group"
					aria-label="Suggested answers"
					className="space-y-1.5"
				>
					{normalizedOptions.map((option, index) => (
						<button
							key={option}
							type="button"
							ref={(el) => {
								optionRefs.current[index] = el;
							}}
							onClick={() => submitOption(option)}
							onKeyDown={(e) => handleOptionKeyDown(e, index)}
							aria-keyshortcuts={String(index + 1)}
							className="flex w-full items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-left text-sm text-foreground transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span
								className="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-muted text-[0.6875rem] font-medium text-muted-foreground"
								aria-hidden="true"
							>
								{index + 1}
							</span>
							<span className="min-w-0">{option}</span>
						</button>
					))}
				</div>
			)}

			{allowCustom && (
				<div className={normalizedOptions.length > 0 ? "mt-2" : ""}>
					{customOpen ? (
						<div className="space-y-1.5">
							<label
								htmlFor={`${questionId}-custom`}
								className="sr-only"
							>
								Type your own answer
							</label>
							<Textarea
								id={`${questionId}-custom`}
								ref={customRef}
								value={customValue}
								maxLength={MAX_CUSTOM_ANSWER_LENGTH}
								rows={2}
								autoFocus
								placeholder="Type your answer…"
								aria-invalid={customError ? "true" : undefined}
								aria-describedby={
									customError
										? `${questionId}-custom-error`
										: undefined
								}
								onChange={(e) => {
									setCustomValue(e.target.value);
									if (customError) {
										setCustomError(null);
									}
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										submitCustom();
									}
								}}
							/>
							{customError && (
								<p
									id={`${questionId}-custom-error`}
									className="text-xs text-destructive"
								>
									{customError}
								</p>
							)}
							<div className="flex items-center justify-between gap-2">
								<span className="text-[0.6875rem] text-muted-foreground">
									{customValue.length}/
									{MAX_CUSTOM_ANSWER_LENGTH}
								</span>
								<div className="flex items-center gap-1.5">
									<Button
										type="button"
										size="sm"
										variant="ghost"
										onClick={() => {
											setCustomOpen(false);
											setCustomValue("");
											setCustomError(null);
										}}
									>
										Back
									</Button>
									<Button
										type="button"
										size="sm"
										onClick={submitCustom}
									>
										Send answer
									</Button>
								</div>
							</div>
						</div>
					) : (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-auto gap-2 px-2 py-1.5 text-muted-foreground hover:text-foreground"
							onClick={() => setCustomOpen(true)}
						>
							<PencilLineIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							Type your own answer
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
