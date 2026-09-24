"use client";

/**
 * The full explanation of a gated capability (Fizzy #1930).
 *
 * Where the badge says what state a capability is in and the action says what
 * is disabled, this says why and offers the way out. It follows the shape
 * `ReportConfigBanner` already established — tone bar, icon chip, title,
 * message, inline actions — so a project page does not grow a second visual
 * language for the same idea.
 *
 * ## Dismissal is only ever offered on a warning
 *
 * Every other state is a statement about whether the capability can run, which
 * is not a viewer's to overrule: hiding a block would not make the action
 * work, it would only remove the explanation of why it does not. The control
 * is absent — not disabled — for anything but a warning, and the server
 * refuses a non-warning dismissal as well, so the guarantee holds from both
 * ends.
 */

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	Loader2Icon,
	type LucideIcon,
	RotateCwIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type {
	CapabilityGateView,
	GateTone,
} from "../../lib/capability-gate-view";
import {
	SNOOZE_DURATIONS,
	type SnoozeDuration,
	useCapabilityGate,
	useCapabilityGates,
} from "./useCapabilityGates";

/**
 * Every surface colour is a token.
 *
 * `--destructive` for a block, `--highlight` for a warning, and the neutral
 * card surface for work in progress — which is not a problem and must not be
 * painted like one.
 */
const TONE_CONTAINER: Record<GateTone, string> = {
	destructive: "border-destructive/30 bg-destructive/5",
	warning: "border-highlight/40 bg-highlight/5",
	info: "border-border bg-muted",
};

const TONE_BAR: Record<GateTone, string> = {
	destructive: "bg-destructive",
	warning: "bg-highlight",
	info: "bg-muted-foreground/40",
};

const TONE_ICON: Record<GateTone, string> = {
	destructive: "bg-destructive/10 text-destructive",
	warning: "bg-highlight/10 text-highlight",
	info: "bg-background text-muted-foreground",
};

const TONE_GLYPH: Record<GateTone, LucideIcon> = {
	destructive: TriangleAlertIcon,
	warning: AlertCircleIcon,
	info: Loader2Icon,
};

/**
 * The retry control for a failed or stalled job.
 *
 * Three booleans decide this, and they fail independently:
 *
 *  - **`supported: false`** — there is no job to re-enqueue. The only case
 *    where rendering nothing is right, because there is no action to describe.
 *  - **`permitted: false`** — a re-run needs a higher permission than viewing
 *    the gate does, so an ordinary member routinely meets a block they cannot
 *    clear. The control renders **disabled**, never hidden, and says who can
 *    clear it. Hiding it would make the block look unfixable, which is the
 *    opposite of what this feature is for.
 *  - **`available: false`** — a run is already in flight, so pressing again
 *    would only duplicate it.
 *
 * The reason for a disabled retry is adjacent text pointed at by
 * `aria-describedby`, never a tooltip: a disabled button leaves the tab order,
 * so a tooltip on it is unreachable by keyboard and silent to a screen reader.
 *
 * With no retry path at all — the surface passes none and the banner's own
 * codebase re-index does not apply — nothing renders, rather than a button with
 * nothing behind it. That is a different statement from "you may not retry".
 */
function CapabilityGateRetryButton({
	view,
	onRetry,
	isRetrying = false,
}: {
	view: CapabilityGateView;
	onRetry?: () => void;
	isRetrying?: boolean;
}) {
	const t = useTranslations("projects.capabilityGates");
	const reasonId = useId();

	if (!view.retry.supported || !onRetry) {
		return null;
	}

	const { permitted, available } = view.retry;
	const blockedReason = !permitted
		? "retry.notPermitted"
		: !available
			? "retry.notAvailable"
			: null;

	return (
		<div className="flex flex-col items-start gap-1">
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={onRetry}
				disabled={blockedReason !== null || isRetrying}
				aria-describedby={blockedReason ? reasonId : undefined}
				autoLoading={false}
			>
				{isRetrying ? (
					<Loader2Icon
						className="motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : (
					<RotateCwIcon aria-hidden="true" />
				)}
				{/*
				 * The remedy's own label when it has one, which for every
				 * retryable rule in the registry today it does. The fallback
				 * covers a gate that supports a retry without naming
				 * `RETRY_JOB` as its remedy — possible by the contract's types,
				 * and a button with no label would be the worst way to find out.
				 */}
				{t(view.ctaLabel ?? "retry.action")}
			</Button>
			{blockedReason && (
				<p id={reasonId} className="text-muted-foreground text-xs">
					{t(blockedReason)}
				</p>
			)}
		</div>
	);
}

const DURATION_LABEL: Record<SnoozeDuration, string> = {
	session: "dismiss.session",
	"1d": "dismiss.oneDay",
	"7d": "dismiss.sevenDays",
	"30d": "dismiss.thirtyDays",
	forever: "dismiss.forever",
};

export function CapabilityGateBanner({
	capabilityKey,
	onRetry,
	isRetrying,
	className,
}: {
	capabilityKey: string;
	/**
	 * A retry this surface performs itself — the Security page re-running a
	 * stalled scan. Codebase retries need none: the banner re-indexes the
	 * repository the gate names on its own.
	 */
	onRetry?: () => void;
	isRetrying?: boolean;
	className?: string;
}) {
	const t = useTranslations("projects.capabilityGates");
	const { gate, view } = useCapabilityGate(capabilityKey);
	const { suppress, linkFor, codebaseRetryFor, codebaseRetrying } =
		useCapabilityGates();

	// Available, hidden, suppressed, still loading, or the flag is off. All of
	// them mean the page looks exactly as it does today.
	if (view === null) {
		return null;
	}

	const Glyph = TONE_GLYPH[view.tone];
	const link =
		view.ctaKind === "navigate" && view.ctaTarget
			? linkFor(view.ctaTarget)
			: null;
	const codebaseRetry = gate ? codebaseRetryFor(gate) : undefined;
	const retry = onRetry ?? codebaseRetry;
	const retrying = onRetry ? isRetrying : codebaseRetrying;

	return (
		<div
			// A block is an error the viewer has to act on; a warning or a
			// running job is not, and announcing it assertively would interrupt
			// a screen-reader user mid-sentence for news that can wait.
			role={view.tone === "destructive" ? "alert" : "status"}
			className={cn(
				"relative flex items-start gap-3 overflow-hidden rounded-xl border p-4 pl-5",
				"motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:animate-in",
				TONE_CONTAINER[view.tone],
				className,
			)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"absolute inset-y-0 left-0 w-1",
					TONE_BAR[view.tone],
				)}
			/>
			<span
				className={cn(
					"mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
					TONE_ICON[view.tone],
				)}
			>
				<Glyph
					className={cn(
						"size-[18px]",
						view.state === "PROCESSING" &&
							"motion-safe:animate-spin",
					)}
					aria-hidden="true"
				/>
			</span>

			{/* A container query, not a breakpoint: the banner also sits in
			    narrow popovers, where the action has to drop below the text. */}
			<div className="@container min-w-0 flex-1">
				<div className="flex flex-col items-start gap-3 @md:flex-row @md:items-center">
					<div className="min-w-0 flex-1">
						<p className="font-semibold text-foreground text-sm">
							{t(view.title)}
						</p>
						<p className="mt-0.5 max-w-[70ch] text-muted-foreground text-sm leading-relaxed">
							{t(view.body, view.params)}
						</p>
					</div>

					<div className="flex shrink-0 items-center gap-2 empty:hidden">
						{view.ctaKind === "retry" && (
							<CapabilityGateRetryButton
								view={view}
								onRetry={retry}
								isRetrying={retrying}
							/>
						)}
						{link &&
							view.ctaLabel &&
							("href" in link ? (
								<Button
									asChild
									size="sm"
									variant={
										view.tone === "destructive"
											? "error"
											: "primary"
									}
								>
									<Link href={link.href}>
										{t(view.ctaLabel)}
									</Link>
								</Button>
							) : (
								<Button
									type="button"
									size="sm"
									variant={
										view.tone === "destructive"
											? "error"
											: "primary"
									}
									onClick={link.onSelect}
								>
									{t(view.ctaLabel)}
								</Button>
							))}
					</div>
				</div>
			</div>

			{view.dismissible && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={t("dismiss.action")}
							className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center self-start rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon className="size-4" aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{SNOOZE_DURATIONS.map((duration) => (
							<DropdownMenuItem
								key={duration}
								onSelect={() =>
									suppress({
										capabilityKey: view.capabilityKey,
										// The reason exactly as rendered. The
										// server re-resolves and refuses a
										// mismatch, which is how a warning that
										// moved on between the render and the
										// click fails safe.
										reasonKey: view.reasonKey,
										duration,
									})
								}
							>
								{t(DURATION_LABEL[duration])}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}
