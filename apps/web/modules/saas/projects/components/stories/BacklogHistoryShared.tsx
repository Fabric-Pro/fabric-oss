"use client";

/**
 * Shared read-only primitives for the AI Backlog change-history tabs
 * ("Session history" + "Audit") inside the proposals review drawer.
 *
 * Body copy here is deliberately literal-string to match the surrounding
 * `PendingBacklogProposalsInbox` component, and token-only per the design system
 * (no hardcoded hex, no glassmorphism, editorial empty states). Tooltip copy is
 * the one exception — `fabric/standards/frontend/tooltips.md` requires it to
 * live in the `tooltips.*` i18n namespace.
 */

import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

function toDate(value: string | Date): Date {
	return typeof value === "string" ? new Date(value) : value;
}

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
});

/**
 * Timestamp shown as a relative line ("2 hours ago") with the absolute local
 * date-time + timezone below it (FR-2/FR-10 — date, time, timezone; localized
 * display from UTC storage). Visible text, never hover-only, for accessibility.
 */
export function HistoryTimestamp({
	value,
	compact = false,
}: {
	value: string | Date;
	/**
	 * Single line, sitting inline among other metadata rather than in its own
	 * column. The absolute time moves to the accessible name instead of a second
	 * line — used by the Priority row's "set <when>" stamp, where the full
	 * date-time is one disclosure away in the item's own history.
	 */
	compact?: boolean;
}) {
	const date = toDate(value);
	const iso = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
	const relative = iso
		? formatDistanceToNow(date, { addSuffix: true })
		: "Unknown time";
	const absolute = iso ? ABSOLUTE_FORMAT.format(date) : "";
	if (compact) {
		return (
			<time
				dateTime={iso}
				title={absolute}
				aria-label={absolute ? `${relative} (${absolute})` : relative}
				className="whitespace-nowrap"
			>
				{relative}
			</time>
		);
	}
	return (
		// `shrink-0` + `whitespace-nowrap`: the timestamp keeps its natural width
		// and never gets squeezed by a long title, so every row's timestamp wraps
		// identically (relative on one line, absolute on the next) — which keeps
		// the row heights uniform.
		<time
			dateTime={iso}
			className="block shrink-0 whitespace-nowrap text-right text-xs leading-tight"
		>
			<span className="text-muted-foreground">{relative}</span>
			{absolute ? (
				<span className="block text-[11px] text-muted-foreground/70">
					{absolute}
				</span>
			) : null}
		</time>
	);
}

/** A compact "source of change" pill (AI Update / Slack / Teams / …). */
function SourceTag({ source }: { source: string }) {
	const t = useTranslations("tooltips.stories");
	// `role="img"` + `aria-label` already carry the accessible identity, so only
	// the hover affordance moves to a tooltip — no `sr-only` duplicate needed.
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					role="img"
					aria-label={`Source: ${source}`}
					className="inline-flex shrink-0 items-center gap-1 rounded-full border border-secondary/30 bg-secondary/15 px-1.5 py-0 font-medium text-[10px] text-secondary"
				>
					<SparklesIcon className="size-2.5" aria-hidden="true" />
					{source}
				</span>
			</TooltipTrigger>
			<TooltipContent>{t("changeSource", { source })}</TooltipContent>
		</Tooltip>
	);
}

/**
 * Actor attribution: the person who made the change (avatar + name), plus — when
 * the change came from an automated source (AI Update / channel proposal) — a
 * small source pill alongside them. Manual edits show just the person.
 */
export function HistoryActor({
	name,
	email,
	image,
	source,
}: {
	name: string | null;
	/** Fallback identity when the user has no display name (only an email). */
	email?: string | null;
	/** Avatar URL of the triggering user, when known. */
	image?: string | null;
	/** Change source label (e.g. "AI Update" / "Slack"); null/absent = manual. */
	source?: string | null;
}) {
	const display = name ?? email ?? "Unknown user";
	const initials =
		display
			.split(/\s+/)
			.map((part) => part.charAt(0))
			.join("")
			.slice(0, 2)
			.toUpperCase() || "?";

	return (
		<span className="inline-flex items-center gap-1.5">
			<Avatar className="size-5">
				{image ? <AvatarImage src={image} alt="" /> : null}
				<AvatarFallback className="text-[9px] font-medium">
					{initials}
				</AvatarFallback>
			</Avatar>
			<span className="text-xs font-medium text-foreground">
				{display}
			</span>
			{source ? <SourceTag source={source} /> : null}
		</span>
	);
}

/** Editorial empty state (dot-grid + serif heading) per the design system. */
export function HistoryEmptyState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div
			// `currentColor` (a faint foreground tint) so the dot-grid texture is
			// visible in BOTH themes — a hardcoded black rgba vanishes on dark.
			className="flex flex-col items-center justify-center rounded-lg border border-border/60 bg-muted px-6 py-12 text-center text-foreground/10"
			style={{
				backgroundImage:
					"radial-gradient(circle, currentColor 1px, transparent 1px)",
				backgroundSize: "32px 32px",
			}}
		>
			<h3 className="font-serif text-2xl font-normal text-foreground">
				{title}
			</h3>
			<p className="mt-2 max-w-sm text-sm text-muted-foreground">
				{description}
			</p>
		</div>
	);
}

/** Loading skeleton rows. */
export function HistoryLoading({ rows = 3 }: { rows?: number }) {
	return (
		<div className="space-y-3" aria-busy="true" aria-live="polite">
			{Array.from({ length: rows }).map((_, i) => (
				<div
					key={i}
					className="h-20 rounded-lg border border-border/60 bg-muted motion-safe:animate-pulse"
				/>
			))}
		</div>
	);
}

/** Error panel with retry. */
export function HistoryError({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-6 py-8 text-center"
		>
			<AlertTriangleIcon
				className="size-5 text-destructive"
				aria-hidden="true"
			/>
			<p className="text-sm text-foreground">
				Couldn't load history. Please try again.
			</p>
			<Button variant="outline" size="sm" onClick={onRetry}>
				Retry
			</Button>
		</div>
	);
}

/** Prev/next pager (cursor-stack based). */
export function HistoryPager({
	canPrev,
	canNext,
	isFetching,
	onPrev,
	onNext,
	showingCount,
	page,
}: {
	canPrev: boolean;
	canNext: boolean;
	isFetching: boolean;
	onPrev: () => void;
	onNext: () => void;
	showingCount: number;
	/** 1-based current page (cursor depth), shown so the reader keeps their place. */
	page?: number;
}) {
	if (!canPrev && !canNext) {
		return null;
	}
	return (
		<div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3">
			<span className="text-xs text-muted-foreground">
				{isFetching ? (
					<span className="inline-flex items-center gap-1">
						<Loader2Icon
							className="size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Loading…
					</span>
				) : (
					<>
						{page ? (
							<span className="font-medium text-foreground">
								Page {page}
							</span>
						) : null}
						{page ? " · " : ""}
						{`${showingCount} ${showingCount === 1 ? "entry" : "entries"} on this page`}
					</>
				)}
			</span>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={onPrev}
					disabled={!canPrev || isFetching}
				>
					<ChevronLeftIcon className="size-4" aria-hidden="true" />
					Previous
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={onNext}
					disabled={!canNext || isFetching}
				>
					Next
					<ChevronRightIcon className="size-4" aria-hidden="true" />
				</Button>
			</div>
		</div>
	);
}
