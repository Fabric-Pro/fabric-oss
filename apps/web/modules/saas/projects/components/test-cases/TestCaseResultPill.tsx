"use client";

import { cn } from "@ui/lib";
import {
	CircleCheckIcon,
	CircleSlashIcon,
	CircleXIcon,
	type LucideIcon,
	MinusIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { RESULT_TONE, type TestResult, TONE_CLASSES } from "./constants";

/**
 * The icon per run result. The icon (a distinct glyph per result) plus the text
 * label carry the meaning — colour is a secondary, reinforcing signal — so the
 * pill never communicates result through colour alone (WCAG 1.4.1).
 */
const RESULT_ICON: Record<TestResult, LucideIcon> = {
	PASSED: CircleCheckIcon,
	FAILED: CircleXIcon,
	BLOCKED: TriangleAlertIcon,
	// A struck-through circle for "deliberately not run", distinct from the bare
	// dash of NOT_RUN ("nobody has run it yet") — the two must not read alike,
	// since the whole point of SKIPPED is that it is not merely pending.
	SKIPPED: CircleSlashIcon,
	NOT_RUN: MinusIcon,
};

/** Built-in English labels so the pill renders (and unit-tests) without an i18n provider. */
const RESULT_LABEL: Record<TestResult, string> = {
	PASSED: "Passed",
	FAILED: "Failed",
	BLOCKED: "Blocked",
	SKIPPED: "Skipped",
	NOT_RUN: "Not run",
};

type Props = {
	result: TestResult;
	/** Optional translated label; falls back to the built-in English label. */
	label?: string;
	/**
	 * Icon-only (tight layouts): the label stays available to assistive tech via
	 * an `aria-label` + visually-hidden text, so meaning is never lost.
	 */
	iconOnly?: boolean;
	/** Drop the tinted pill chrome — just the tone icon + label inline. */
	plain?: boolean;
	className?: string;
};

/**
 * A run-result pill: a tone-coloured glyph + a text label. Shared primitive —
 * the cases list, the editor drawer and the plan detail all
 * render the current `TestResult` through this.
 */
export function TestCaseResultPill({
	result,
	label,
	iconOnly = false,
	plain = false,
	className,
}: Props) {
	// Fall back rather than index blindly. `result` comes from the database, and
	// the Temporal worker deploys on a DIFFERENT pipeline from this bundle — so
	// during a deploy window the worker can already be writing a result value
	// this bundle has never heard of. Indexing straight through would make
	// `tone` undefined and `tone.pill` throw, white-screening the whole cases
	// list over one unrecognised string. An unknown result renders neutral with
	// its raw key, which is legible and survives.
	const tone = TONE_CLASSES[RESULT_TONE[result] ?? "muted"];
	const Icon = RESULT_ICON[result] ?? MinusIcon;
	const text = label ?? RESULT_LABEL[result] ?? result;
	const chrome = cn(
		"inline-flex items-center gap-1.5 font-medium text-foreground text-xs",
		!plain && cn("rounded-full border px-2 py-0.5", tone.pill),
		className,
	);
	const icon = (
		<Icon
			aria-hidden="true"
			className={cn("size-3.5 shrink-0", tone.text)}
		/>
	);

	// Icon-only: an `img` role carries the (otherwise visual) label to AT.
	if (iconOnly) {
		return (
			<span className={chrome} role="img" aria-label={text}>
				{icon}
				<span className="sr-only">{text}</span>
			</span>
		);
	}

	return (
		<span className={chrome}>
			{icon}
			{text}
		</span>
	);
}
