"use client";

/**
 * Clarity helpers for the Security & Accessibility page: an "about this page"
 * info popover, a shared Legend (severity / category / status / rule sources),
 * and a small inline info hint for individual settings.
 *
 * The hover-pin popover mirrors the Architecture Decision Log ("Decisions")
 * page so the two surfaces feel consistent: hovering previews, clicking pins
 * it open until dismissed.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { cn } from "@ui/lib";
import { InfoIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConfidenceChip } from "./ConfidenceChip";
import {
	CATEGORY_BADGE_VARIANT,
	CATEGORY_LABEL,
	type ConfidenceLevel,
	type FindingStatus,
	type ScanCategory,
	type ScanSeverity,
	SEVERITY_BADGE_VARIANT,
	SEVERITY_LABEL,
	SEVERITY_ORDER,
	STATUS_BADGE_VARIANT,
	STATUS_LABEL,
} from "./lib";

type HoverTriggerHandlers = {
	onClick: () => void;
	onPointerEnter: () => void;
	onPointerLeave: () => void;
	onFocus: () => void;
	onBlur: () => void;
	"aria-expanded": boolean;
	"aria-haspopup": "dialog";
};

/**
 * Popover that previews on hover and pins open on click: hovering the trigger
 * (or its content) opens it and moving away closes it — unless it was clicked,
 * which keeps it open until dismissed (click again, click outside, or Escape).
 * Mirrors the Decisions page so both surfaces behave identically.
 */
function HoverPinPopover({
	align = "start",
	contentClassName,
	trigger,
	children,
}: {
	align?: "start" | "center" | "end";
	contentClassName?: string;
	trigger: (handlers: HoverTriggerHandlers) => ReactNode;
	children: ReactNode;
}) {
	const [pinned, setPinned] = useState(false);
	const [hovered, setHovered] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (closeTimer.current) {
				clearTimeout(closeTimer.current);
			}
		},
		[],
	);

	const open = pinned || hovered;
	const enter = () => {
		if (closeTimer.current) {
			clearTimeout(closeTimer.current);
		}
		setHovered(true);
	};
	const leave = () => {
		closeTimer.current = setTimeout(() => setHovered(false), 140);
	};

	return (
		<Popover
			open={open}
			onOpenChange={(o) => {
				if (!o) {
					setPinned(false);
					setHovered(false);
				}
			}}
		>
			<PopoverAnchor asChild>
				{trigger({
					onClick: () => setPinned((p) => !p),
					onPointerEnter: enter,
					onPointerLeave: leave,
					onFocus: enter,
					onBlur: leave,
					"aria-expanded": open,
					"aria-haspopup": "dialog",
				})}
			</PopoverAnchor>
			<PopoverContent
				align={align}
				className={contentClassName}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onPointerEnter={enter}
				onPointerLeave={leave}
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

/** How to read each severity. */
const SEVERITY_HELP: Record<ScanSeverity, string> = {
	CRITICAL: "Exploitable or blocking — address before shipping.",
	HIGH: "Serious risk or barrier — prioritize a fix.",
	MEDIUM: "Moderate impact — should be addressed.",
	LOW: "Minor or informational — fix when convenient.",
};

/** What each category is checked against. */
const CATEGORY_HELP: Record<ScanCategory, string> = {
	SECURITY: "Checked against the OWASP Top 10 (2021) + your custom rules.",
	ACCESSIBILITY: "Checked against WCAG 2.1 Level AA + your custom rules.",
};

/** What each finding status means, and how the view treats it. */
const STATUS_HELP: Record<FindingStatus, string> = {
	OPEN: "Needs attention. New findings start here and show by default.",
	RESOLVED: "You've addressed it. Kept for the record, hidden from Open.",
	DISMISSED: "Doesn't apply or won't fix. Hidden from the default view.",
};

/** Representative float per level so the legend renders the real chip. */
const CONFIDENCE_SWATCH: Record<ConfidenceLevel, number> = {
	HIGH: 0.9,
	MEDIUM: 0.6,
	LOW: 0.3,
};

/** How to read each confidence level — shown with text, never color alone. */
const CONFIDENCE_HELP: ReadonlyArray<{
	level: ConfidenceLevel;
	help: string;
}> = [
	{
		level: "HIGH",
		help: "The scanner was confident this is real (evidence-backed).",
	},
	{
		level: "MEDIUM",
		help: "Moderately confident — worth a look to confirm.",
	},
	{
		level: "LOW",
		help: "Unsure — hidden from the default view (collapsed under “Show low-confidence findings”); one click reveals it. Nothing is deleted.",
	},
];

/** What the per-finding "Block" action and the Blocked chip mean. */
const WORK_ITEM_HELP: ReadonlyArray<{ label: string; help: string }> = [
	{
		label: "Block F-XXX",
		help: "When a finding is about an existing feature, block that work item — the finding becomes the block reason, recorded in the work item's version history.",
	},
	{
		label: "Blocked → F-XXX",
		help: "The work item this finding is about is blocked. The chip links to it; hover to see the reason.",
	},
];

/** Rule-source attribution shown on every finding. */
const RULE_SOURCES: ReadonlyArray<{ label: string; help: string }> = [
	{
		label: "OWASP Top 10",
		help: "The standard web-app security risk categories (A01–A10).",
	},
	{
		label: "WCAG 2.1 AA",
		help: "Accessibility success criteria (e.g. 1.4.3 Contrast (Minimum)).",
	},
	{
		label: "Semgrep",
		help: "A real static-analysis (SAST) rule run over your connected repository's code — shown as “Semgrep: <rule>”.",
	},
	{
		label: "Secret history",
		help: "A secret found in your repository's git history (gitleaks) — committed then removed — shown as “Secret history: <rule>”.",
	},
	{
		label: "Custom",
		help: "A project-specific rule you defined — shown with a “Custom rule” badge.",
	},
];

function LegendColumn({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<div>
			<p className="app-editorial-label mb-2.5">{title}</p>
			<ul className="space-y-2.5">{children}</ul>
		</div>
	);
}

function LegendRow({ badge, help }: { badge: ReactNode; help: string }) {
	return (
		<li className="flex items-start gap-2">
			<span className="mt-px shrink-0">{badge}</span>
			<span className="text-muted-foreground text-xs leading-snug">
				{help}
			</span>
		</li>
	);
}

/**
 * Shared legend explaining everything a finding shows: severity, category,
 * status, and where the rule comes from. Uses the same Badge variants as the
 * findings list so the swatches match exactly.
 */
function ScanLegend() {
	return (
		<div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
			<LegendColumn title="Severity">
				{SEVERITY_ORDER.map((s) => (
					<LegendRow
						key={s}
						badge={
							<Badge variant={SEVERITY_BADGE_VARIANT[s]}>
								{SEVERITY_LABEL[s]}
							</Badge>
						}
						help={SEVERITY_HELP[s]}
					/>
				))}
			</LegendColumn>

			<LegendColumn title="Status">
				{(["OPEN", "RESOLVED", "DISMISSED"] as FindingStatus[]).map(
					(s) => (
						<LegendRow
							key={s}
							badge={
								<Badge variant={STATUS_BADGE_VARIANT[s]}>
									{STATUS_LABEL[s]}
								</Badge>
							}
							help={STATUS_HELP[s]}
						/>
					),
				)}
			</LegendColumn>

			<LegendColumn title="Category">
				{(["SECURITY", "ACCESSIBILITY"] as ScanCategory[]).map((c) => (
					<LegendRow
						key={c}
						badge={
							<Badge variant={CATEGORY_BADGE_VARIANT[c]}>
								{CATEGORY_LABEL[c]}
							</Badge>
						}
						help={CATEGORY_HELP[c]}
					/>
				))}
			</LegendColumn>

			<LegendColumn title="Confidence">
				{CONFIDENCE_HELP.map(({ level, help }) => (
					<LegendRow
						key={level}
						badge={
							<ConfidenceChip
								confidence={CONFIDENCE_SWATCH[level]}
							/>
						}
						help={help}
					/>
				))}
			</LegendColumn>

			<LegendColumn title="Rule source">
				{RULE_SOURCES.map((r) => (
					<LegendRow
						key={r.label}
						badge={
							<Badge variant="outline" className="font-normal">
								{r.label}
							</Badge>
						}
						help={r.help}
					/>
				))}
			</LegendColumn>

			<LegendColumn title="Work item">
				{WORK_ITEM_HELP.map((w) => (
					<LegendRow
						key={w.label}
						badge={
							<Badge
								variant={
									w.label.startsWith("Blocked")
										? "destructive"
										: "outline"
								}
								className="font-normal"
							>
								{w.label}
							</Badge>
						}
						help={w.help}
					/>
				))}
			</LegendColumn>
		</div>
	);
}

/**
 * "Legend" pill that opens {@link ScanLegend}. Place next to the results count.
 */
export function ScanLegendButton() {
	return (
		<HoverPinPopover
			align="end"
			contentClassName="max-h-[80vh] w-[min(94vw,40rem)] overflow-y-auto"
			trigger={(h) => (
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 font-medium text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
					{...h}
				>
					<InfoIcon className="size-3" aria-hidden="true" />
					Legend
				</button>
			)}
		>
			<ScanLegend />
		</HoverPinPopover>
	);
}

/**
 * "About this page" (i) button — explains what the scanners do, what gets
 * scanned, and how findings behave. Sits next to the page title.
 */
export function ScanPageInfoButton() {
	return (
		<HoverPinPopover
			align="start"
			contentClassName="w-[min(92vw,32rem)] text-sm"
			trigger={(h) => (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-6 rounded-full text-muted-foreground hover:text-foreground"
					aria-label="About Security & Accessibility scanning"
					{...h}
				>
					<InfoIcon className="size-4" aria-hidden="true" />
				</Button>
			)}
		>
			<p className="font-medium">Security & Accessibility scanning</p>
			<p className="mt-1.5 text-muted-foreground">
				Up to four scan engines check this project:{" "}
				<span className="font-medium text-foreground">AI Security</span>{" "}
				(OWASP Top 10),{" "}
				<span className="font-medium text-foreground">
					AI Accessibility
				</span>{" "}
				(WCAG 2.1 AA), and — when a repository is connected —{" "}
				<span className="font-medium text-foreground">
					Semgrep (SAST)
				</span>{" "}
				over your code and a{" "}
				<span className="font-medium text-foreground">
					git-history secret scan
				</span>
				. Each finding comes with a severity, a confidence level, a fix
				suggestion, and a link to the feature, file, or commit it’s
				about.
			</p>
			<p className="mt-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					What gets scanned:
				</span>{" "}
				by default, your Fabric-held context — the project’s features
				and generated documents — so you can review at design time,
				before any code exists. Optionally enable{" "}
				<span className="font-medium text-foreground">
					Semgrep (SAST)
				</span>{" "}
				under Configuration to also run real static analysis over a
				connected repository’s code.
			</p>
			<p className="mt-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					Findings are advisory by default
				</span>{" "}
				(Warn mode) and never block work. Run a scan on demand, or turn
				on auto-scan to run one when a feature reaches your maturation
				gate. Add your own checks under{" "}
				<span className="font-medium text-foreground">
					Configuration → Custom rules
				</span>
				.
			</p>
			<p className="mt-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					Confidence &amp; the default view:
				</span>{" "}
				every finding carries a{" "}
				<span className="font-medium text-foreground">confidence</span>{" "}
				— how sure the scanner is it's a real issue. Low-confidence
				findings (and noisy “audit”-category static-analysis rules) are{" "}
				<span className="font-medium text-foreground">
					collapsed out of the default view
				</span>{" "}
				— nothing is deleted, and one click reveals them. After each
				scan an{" "}
				<span className="font-medium text-foreground">
					AI false-positive review
				</span>{" "}
				auto-dismisses likely false positives{" "}
				<span className="font-medium text-foreground">reversibly</span>{" "}
				(you can reopen any of them) and keeps confirmed findings
				visible. It's best-effort, and the default view still holds even
				if you turn it off under Configuration.
			</p>
			<p className="mt-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					Block the related work item:
				</span>{" "}
				when a finding is about an existing feature, open it and use{" "}
				<span className="font-medium text-foreground">Block F-XXX</span>{" "}
				to mark that work item blocked — the finding becomes the reason
				(shown on hover), recorded in the work item's version history.
				The <span className="font-medium text-foreground">View</span>{" "}
				link jumps to the file, commit, or feature so you can verify it.
			</p>
			<p className="mt-2 text-muted-foreground">
				<span className="font-medium text-foreground">
					Scan vs Full scan:
				</span>{" "}
				“Scan” re-analyzes only what changed since your last scan and
				keeps the rest (fast); “Full scan” (in the dropdown) re-analyzes
				everything. Results reflect the latest run, and History keeps
				earlier runs with their duration, cost, and model.
			</p>
		</HoverPinPopover>
	);
}

/**
 * Small inline (i) for an individual setting or label. Hover or focus to read.
 * Use sparingly next to a control whose name needs a sentence of context.
 */
export function InfoHint({
	label,
	children,
	align = "start",
	wide = false,
}: {
	/** Accessible name, e.g. "About enforcement mode". */
	label: string;
	children: ReactNode;
	align?: "start" | "center" | "end";
	/** Wider, scrollable popover — for richer content like a standard breakdown. */
	wide?: boolean;
}) {
	return (
		<HoverPinPopover
			align={align}
			contentClassName={cn(
				"text-xs leading-relaxed",
				wide
					? "max-h-[70vh] w-[min(92vw,30rem)] overflow-y-auto"
					: "w-[min(90vw,22rem)]",
			)}
			trigger={(h) => (
				<button
					type="button"
					aria-label={label}
					className={cn(
						"inline-flex size-4 items-center justify-center rounded-full text-muted-foreground/70 align-middle",
						"transition-colors hover:text-foreground focus-visible:text-foreground",
					)}
					{...h}
				>
					<InfoIcon className="size-3.5" aria-hidden="true" />
				</button>
			)}
		>
			<div className="text-muted-foreground">{children}</div>
		</HoverPinPopover>
	);
}
