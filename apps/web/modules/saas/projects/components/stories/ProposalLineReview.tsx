"use client";

/**
 * One body field of a proposed update, reviewed line by line: shared lines
 * for context and each changed region with its own Accept/Reject control.
 * The whole-field toggle stays in the heading; while the field is rejected
 * whole, its regions cannot be decided one by one.
 */

import {
	buildLineHunks,
	type LineHunk,
} from "@repo/utils/proposal-update-summary";
import { cn } from "@ui/lib";
import { useMemo } from "react";
import { slugifyLabel } from "./BacklogChangeDetailFields";
import { FieldAcceptToggle } from "./FieldAcceptToggle";

/** Shared runs longer than this show their first and last lines only. */
const CONTEXT_LINES = 2;

function SharedLines({ lines }: { lines: string[] }) {
	const hidden = lines.length - CONTEXT_LINES * 2;
	const shown =
		hidden > 0
			? [lines.slice(0, CONTEXT_LINES), lines.slice(-CONTEXT_LINES)]
			: [lines];
	return (
		<div className="text-xs text-muted-foreground">
			{shown.map((part, partIndex) => (
				<div key={partIndex}>
					{partIndex === 1 && (
						<p className="py-0.5 italic">
							{hidden} unchanged {hidden === 1 ? "line" : "lines"}
						</p>
					)}
					{part.map((line, lineIndex) => (
						<p
							key={lineIndex}
							className="whitespace-pre-wrap break-words"
						>
							{line || " "}
						</p>
					))}
				</div>
			))}
		</div>
	);
}

function ChangedLines({
	hunk,
	rejected,
}: {
	hunk: Extract<LineHunk, { kind: "change" }>;
	rejected: boolean;
}) {
	return (
		<div className="space-y-0.5 text-sm">
			{hunk.removed.map((line, lineIndex) => (
				<del
					key={`removed-${lineIndex}`}
					className={cn(
						"block whitespace-pre-wrap break-words rounded-sm px-1.5",
						rejected
							? "no-underline text-foreground"
							: "bg-destructive/5 text-destructive",
					)}
				>
					<span className="sr-only">Removed: </span>
					<span aria-hidden="true">− </span>
					{line || " "}
				</del>
			))}
			{hunk.added.map((line, lineIndex) => (
				<ins
					key={`added-${lineIndex}`}
					className={cn(
						"block whitespace-pre-wrap break-words rounded-sm px-1.5 no-underline",
						rejected
							? "text-muted-foreground line-through"
							: "bg-success/5 text-success",
					)}
				>
					<span className="sr-only">Added: </span>
					<span aria-hidden="true">+ </span>
					{line || " "}
				</ins>
			))}
		</div>
	);
}

export function LineReviewSection({
	label,
	from,
	to,
	rejectedHunks,
	onToggleHunk,
	fieldRejected,
	onToggleField,
	onRestoreHunks,
}: {
	label: string;
	from: string;
	to: string;
	rejectedHunks: ReadonlySet<number>;
	onToggleHunk: (id: number) => void;
	fieldRejected: boolean;
	onToggleField: () => void;
	onRestoreHunks: () => void;
}) {
	const hunks = useMemo(() => buildLineHunks(from, to), [from, to]);
	const total = hunks.filter((hunk) => hunk.kind === "change").length;
	const accepted = fieldRejected
		? 0
		: hunks.filter(
				(hunk) => hunk.kind === "change" && !rejectedHunks.has(hunk.id),
			).length;
	// The field reads as rejected once nothing in it is accepted, whether the
	// reviewer rejected the whole field or every line one by one. Restoring
	// it brings back every line.
	const allRejected = fieldRejected || (total > 0 && accepted === 0);
	const toggleField = () => {
		if (!allRejected) {
			onToggleField();
			return;
		}
		if (fieldRejected) {
			onToggleField();
		}
		onRestoreHunks();
	};
	const headingId = `line-review-${slugifyLabel(label)}`;
	return (
		<section className="space-y-2" aria-labelledby={headingId}>
			<div className="flex items-center justify-between gap-2">
				<h3
					id={headingId}
					className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					{label}
					<span className="ml-2 normal-case tracking-normal text-[10px]">
						{accepted} of {total}{" "}
						{total === 1 ? "change" : "changes"} accepted
					</span>
				</h3>
				<FieldAcceptToggle
					isRejected={allRejected}
					onToggle={toggleField}
					subject={`${label} change`}
				/>
			</div>
			<ol
				className={cn(
					"space-y-2 rounded-md border p-3",
					fieldRejected && "opacity-60",
				)}
			>
				{hunks.map((hunk, position) =>
					hunk.kind === "same" ? (
						<li key={`same-${position}`}>
							<SharedLines lines={hunk.lines} />
						</li>
					) : (
						<li
							key={`change-${hunk.id}`}
							className="flex items-start gap-2 rounded-md border border-border p-2"
						>
							<div className="min-w-0 flex-1">
								<ChangedLines
									hunk={hunk}
									rejected={
										fieldRejected ||
										rejectedHunks.has(hunk.id)
									}
								/>
							</div>
							<FieldAcceptToggle
								isRejected={
									fieldRejected || rejectedHunks.has(hunk.id)
								}
								onToggle={() => onToggleHunk(hunk.id)}
								subject={`${label} change ${hunk.id + 1} of ${total}`}
								disabled={fieldRejected}
							/>
						</li>
					),
				)}
			</ol>
		</section>
	);
}
