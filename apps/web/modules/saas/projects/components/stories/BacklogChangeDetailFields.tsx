"use client";

import { Markdown } from "@ui/components/markdown";
import { cn } from "@ui/lib";
import { FieldAcceptToggle } from "./FieldAcceptToggle";

/**
 * Slugify a label for use in an `id` / `aria-labelledby` reference. The
 * fields rendered here include "Acceptance criteria" — the space would
 * be valid HTML5 but is fragile across older a11y tooling. Lowercase +
 * hyphenate to be safe.
 */
function slugifyLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Render a labeled before/after diff for a long-form text field of the
 * proposal detail dialog.
 *
 * Crucially, NO truncation — the whole point of this dialog is that the
 * user can see the entire proposed text before approving. `<Markdown>`
 * renders the LLM's paragraph/list structure; `break-words` keeps long URLs
 * from blowing out the layout.
 */
export function DetailDiffSection({
	label,
	from,
	to,
	placeholder,
	isRejected,
	onToggleAccept,
}: {
	label: string;
	from?: string;
	to: string;
	placeholder?: string;
	/** When true, this field's change is staged-rejected — the parent
	 * will revert `to` to `from` (or omit) before applying. */
	isRejected?: boolean;
	/** When defined, render an inline "Accept / Reject this change"
	 * toggle next to the field heading. Undefined = no toggle (e.g.,
	 * for create changes where there is nothing to reject from). */
	onToggleAccept?: () => void;
}) {
	const showFrom = from !== undefined && from !== to;
	const headingId = `detail-${slugifyLabel(label)}`;
	return (
		<section
			className={cn(
				"space-y-2",
				// Visually mute the whole section when staged-rejected so
				// the PM can scan the dialog and see at a glance which
				// fields will and won't apply.
				isRejected && "opacity-60",
			)}
			aria-labelledby={headingId}
		>
			<div className="flex items-center justify-between gap-2">
				<h3
					id={headingId}
					className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
				>
					{label}
					{isRejected && (
						<span className="ml-2 normal-case tracking-normal text-[10px] text-muted-foreground">
							— field will be kept as-is
						</span>
					)}
				</h3>
				{showFrom && onToggleAccept && (
					<FieldAcceptToggle
						isRejected={!!isRejected}
						onToggle={onToggleAccept}
						subject={`${label} change`}
					/>
				)}
			</div>
			{showFrom && (
				<div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
					<p className="text-[10px] uppercase tracking-wide text-destructive mb-1">
						Before
					</p>
					{/* Diff signal lives on the box chrome + Before/After
					    labels (and the section-level opacity when rejected),
					    NOT on the body text — so the body can render neutral
					    Markdown. Mirrors VersionDiffViewer / DiffPreviewPanes. */}
					{from && from.length > 0 ? (
						<Markdown className="break-words">{from}</Markdown>
					) : (
						<p className="text-sm text-muted-foreground">(empty)</p>
					)}
				</div>
			)}
			<div
				className={cn(
					"rounded-md border p-3",
					showFrom && !isRejected
						? "border-success/30 bg-success/5"
						: "border-border bg-muted/30",
				)}
			>
				{showFrom && (
					<p
						className={cn(
							"text-[10px] uppercase tracking-wide mb-1",
							isRejected
								? "text-muted-foreground"
								: "text-success",
						)}
					>
						After
					</p>
				)}
				{to.length > 0 ? (
					<Markdown className="break-words">{to}</Markdown>
				) : (
					<p className="text-sm text-muted-foreground">
						{placeholder ?? "(empty)"}
					</p>
				)}
			</div>
		</section>
	);
}

/**
 * Compact metadata field for short scalar values (priority, size,
 * parent identifiers). Renders inline `from → to` when changing.
 */
export function MetadataField({
	label,
	from,
	to,
	isRejected,
	onToggleAccept,
}: {
	label: string;
	from?: string;
	to: string;
	isRejected?: boolean;
	onToggleAccept?: () => void;
}) {
	const changed = from !== undefined && from !== to;
	return (
		<div className={cn("space-y-1", isRejected && "opacity-60")}>
			<div className="flex items-center justify-between gap-2">
				<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
					{label}
					{isRejected && changed && (
						<span className="ml-2 normal-case tracking-normal text-[10px] text-muted-foreground">
							— kept as-is
						</span>
					)}
				</p>
				{changed && onToggleAccept && (
					<FieldAcceptToggle
						isRejected={!!isRejected}
						onToggle={onToggleAccept}
						subject={`${label} change`}
					/>
				)}
			</div>
			{changed ? (
				<p className="text-sm">
					<span className="line-through text-destructive">
						{from}
					</span>
					<span className="mx-2 text-muted-foreground">→</span>
					<span
						className={cn(
							isRejected
								? "text-muted-foreground line-through"
								: "text-success",
						)}
					>
						{to}
					</span>
				</p>
			) : (
				<p className="text-sm">{to || "—"}</p>
			)}
		</div>
	);
}
