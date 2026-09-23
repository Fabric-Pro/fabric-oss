"use client";

/**
 * "Start Building Your Roadmap" — the Roadmap's empty state (Fizzy #2204,
 * FR1–FR10, FR25, FR34, FR46).
 *
 * Offers Pull, Recommend and Do both as option cards, each explaining itself.
 * A disabled card says why, in text a screen reader reaches through
 * `aria-describedby`, and never reveals more than the missing permission. A
 * thin-context warning (FR56/FR59) sits under a card's description without
 * disabling it, and can be dismissed like any other gate warning. Do both
 * reports its two steps as text with an icon, never by colour alone.
 */

import { useAnalytics } from "@analytics";
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
	CheckCircle2Icon,
	CircleDashedIcon,
	CircleHelpIcon,
	CloudDownloadIcon,
	Loader2Icon,
	type LucideIcon,
	SparklesIcon,
	WorkflowIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { CapabilityGateView } from "../../lib/capability-gate-view";
import {
	SNOOZE_DURATIONS,
	type SnoozeDuration,
	useCapabilityGates,
} from "../capability-gates/useCapabilityGates";
import type {
	DoBothPullOutcome,
	DoBothState,
} from "./roadmap-entry/do-both-sequence";
import { EntryPointReasonText } from "./roadmap-entry/entry-point-reason";
import type {
	EntryPointReason,
	EntryPointStates,
} from "./roadmap-entry/entry-point-states";

type EntryPoint = "pull" | "recommend" | "do-both";

interface RoadmapStartBuildingProps {
	entry: EntryPointStates;
	/** Whether the Roadmap already has (parked) items; changes the intro. */
	hasItems: boolean;
	hiddenCount: number;
	onShowHidden: () => void;
	onPull: () => void;
	onRecommend: () => void;
	onDoBoth: () => void;
	doBoth: DoBothState;
	onRetryPull: () => void;
	onRecommendInstead: () => void;
	onDismissDoBoth: () => void;
	isRecommendStarting: boolean;
}

const DURATION_LABEL: Record<SnoozeDuration, string> = {
	session: "dismiss.session",
	"1d": "dismiss.oneDay",
	"7d": "dismiss.sevenDays",
	"30d": "dismiss.thirtyDays",
	forever: "dismiss.forever",
};

/**
 * A gate WARNING under a card (FR56/FR59): never blocks, and dismissible
 * through the same suppression the gate banner uses.
 */
function GateWarningNote({
	view,
	id,
}: {
	view: CapabilityGateView;
	id: string;
}) {
	const tGates = useTranslations("projects.capabilityGates");
	const { suppress } = useCapabilityGates();
	return (
		<div className="flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/5 px-3 py-2">
			<AlertCircleIcon
				aria-hidden
				className="mt-0.5 size-3.5 shrink-0 text-highlight"
			/>
			<span id={id} className="min-w-0 flex-1 text-xs">
				<span className="block font-medium text-foreground">
					{tGates(view.title)}
				</span>
				<span className="block text-muted-foreground">
					{tGates(view.body, view.params)}
				</span>
			</span>
			{view.dismissible && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={tGates("dismiss.action")}
							className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon aria-hidden className="size-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{SNOOZE_DURATIONS.map((duration) => (
							<DropdownMenuItem
								key={duration}
								onSelect={() =>
									suppress({
										capabilityKey: view.capabilityKey,
										reasonKey: view.reasonKey,
										duration,
									})
								}
							>
								{tGates(DURATION_LABEL[duration])}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

function OptionCard({
	entryPoint,
	icon: Icon,
	title,
	description,
	disabled,
	reason,
	warning = null,
	busy,
	onSelect,
}: {
	entryPoint: EntryPoint;
	icon: LucideIcon;
	title: string;
	description: string;
	disabled: boolean;
	reason: EntryPointReason | null;
	warning?: CapabilityGateView | null;
	busy: boolean;
	onSelect: () => void;
}) {
	const descriptionId = useId();
	const reasonId = useId();
	const warningId = useId();
	const describedBy = [
		descriptionId,
		reason ? reasonId : null,
		warning ? warningId : null,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
			<button
				type="button"
				data-entry-point={entryPoint}
				onClick={onSelect}
				disabled={disabled || busy}
				aria-describedby={describedBy}
				className="flex flex-1 flex-col items-start gap-2 rounded-lg text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:text-inherit"
			>
				<span className="flex items-center gap-2 font-medium text-foreground text-sm">
					{busy ? (
						<Loader2Icon
							aria-hidden
							className="size-4 motion-safe:animate-spin"
						/>
					) : (
						<Icon aria-hidden className="size-4 text-primary" />
					)}
					{title}
				</span>
				<span
					id={descriptionId}
					className="text-muted-foreground text-sm leading-relaxed"
				>
					{description}
				</span>
			</button>
			{reason && <EntryPointReasonText id={reasonId} reason={reason} />}
			{warning && <GateWarningNote id={warningId} view={warning} />}
		</div>
	);
}

type StepStatus =
	| "waiting"
	| "running"
	| "done"
	| "nothingNew"
	| "failed"
	| "unknown";

const STEP_ICON: Record<StepStatus, LucideIcon> = {
	waiting: CircleDashedIcon,
	running: Loader2Icon,
	done: CheckCircle2Icon,
	nothingNew: CheckCircle2Icon,
	failed: XCircleIcon,
	unknown: CircleHelpIcon,
};

/** The pull row once step 2 is under way: how the pull really ended. */
const PULL_STEP: Record<DoBothPullOutcome, StepStatus> = {
	done: "done",
	"nothing-new": "nothingNew",
	failed: "failed",
	unknown: "unknown",
};

function doBothSteps(state: DoBothState): {
	pull: StepStatus;
	recommend: StepStatus;
} {
	switch (state.step) {
		case "idle":
		case "selecting":
			return { pull: "waiting", recommend: "waiting" };
		case "pulling":
			return { pull: "running", recommend: "waiting" };
		case "pull-failed":
			return { pull: "failed", recommend: "waiting" };
		case "pull-unknown":
			return { pull: "unknown", recommend: "waiting" };
		case "recommending":
			return { pull: PULL_STEP[state.pull], recommend: "running" };
		case "recommend-started":
			return { pull: PULL_STEP[state.pull], recommend: "done" };
		case "recommend-failed":
			return { pull: PULL_STEP[state.pull], recommend: "failed" };
	}
}

function DoBothProgress({
	state,
	onRetryPull,
	onRecommendInstead,
	onDismiss,
}: {
	state: DoBothState;
	onRetryPull: () => void;
	onRecommendInstead: () => void;
	onDismiss: () => void;
}) {
	const t = useTranslations("projects.stories.startBuilding.steps");
	const steps = doBothSteps(state);
	const canRecover =
		state.step === "pull-failed" || state.step === "pull-unknown";
	const settled =
		canRecover ||
		state.step === "recommend-started" ||
		state.step === "recommend-failed";

	const rows: { key: "pull" | "recommend"; status: StepStatus }[] = [
		{ key: "pull", status: steps.pull },
		{ key: "recommend", status: steps.recommend },
	];

	return (
		<div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
			<p className="font-medium text-foreground text-sm">{t("label")}</p>
			{/* Only the steps are live: the buttons below must not be
			    re-announced on every change. */}
			<ol aria-live="polite" className="space-y-1.5">
				{rows.map(({ key, status }) => {
					const Icon = STEP_ICON[status];
					return (
						<li
							key={key}
							data-step={key}
							data-status={status}
							className="flex items-center gap-2 text-sm"
						>
							<Icon
								aria-hidden
								className={cn(
									"size-4",
									status === "running" &&
										"motion-safe:animate-spin",
									(status === "done" ||
										status === "nothingNew") &&
										"text-secondary",
									status === "failed" && "text-destructive",
									(status === "waiting" ||
										status === "unknown") &&
										"text-muted-foreground",
								)}
							/>
							<span className="text-foreground">
								{t(`${key}.title`)}
							</span>
							<span className="text-muted-foreground">
								— {t(`${key}.${status}`)}
							</span>
						</li>
					);
				})}
			</ol>
			{state.step === "recommend-failed" && (
				<div role="alert" className="text-xs">
					{state.failure.title && (
						<p className="font-medium text-foreground">
							{state.failure.title}
						</p>
					)}
					<p className="text-muted-foreground">
						{state.failure.body}
					</p>
				</div>
			)}
			{settled && (
				<div className="flex flex-wrap items-center gap-2">
					{canRecover && (
						<>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={onRetryPull}
							>
								{t("retryPull")}
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={onRecommendInstead}
							>
								{t("recommendInstead")}
							</Button>
						</>
					)}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onDismiss}
					>
						{t("dismiss")}
					</Button>
				</div>
			)}
		</div>
	);
}

export function RoadmapStartBuilding({
	entry,
	hasItems,
	hiddenCount,
	onShowHidden,
	onPull,
	onRecommend,
	onDoBoth,
	doBoth,
	onRetryPull,
	onRecommendInstead,
	onDismissDoBoth,
	isRecommendStarting,
}: RoadmapStartBuildingProps) {
	const t = useTranslations("projects.stories.startBuilding");
	const { trackEvent } = useAnalytics();
	const placement = hasItems ? "above-board" : "empty";
	const doBothActive = doBoth.step !== "idle";

	const select = (entryPoint: EntryPoint, run: () => void) => () => {
		trackEvent("roadmap_entry_point_selected", { entryPoint, placement });
		run();
	};

	return (
		<section
			aria-labelledby="roadmap-start-building-heading"
			data-onboarding-target="roadmap-start-building"
			className="space-y-5 px-1 py-8"
		>
			<div className="space-y-2">
				<h2
					id="roadmap-start-building-heading"
					className="font-serif text-2xl font-normal leading-tight text-foreground"
				>
					{t("heading")}
				</h2>
				<p className="max-w-2xl text-muted-foreground text-sm">
					{hasItems ? t("introWithItems") : t("intro")}
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<OptionCard
					entryPoint="pull"
					icon={CloudDownloadIcon}
					title={t("pull.title")}
					description={t("pull.description")}
					disabled={entry.pull.disabled}
					reason={entry.pull.reason}
					busy={false}
					onSelect={select("pull", onPull)}
				/>
				{entry.recommend.visible && (
					<OptionCard
						entryPoint="recommend"
						icon={SparklesIcon}
						title={t("recommend.title")}
						description={t("recommend.description")}
						disabled={entry.recommend.disabled || doBothActive}
						reason={entry.recommend.reason}
						warning={entry.recommend.warning}
						busy={isRecommendStarting && !doBothActive}
						onSelect={select("recommend", onRecommend)}
					/>
				)}
				{entry.doBoth.visible && (
					<OptionCard
						entryPoint="do-both"
						icon={WorkflowIcon}
						title={t("doBoth.title")}
						description={t("doBoth.description")}
						disabled={entry.doBoth.disabled || doBothActive}
						reason={entry.doBoth.reason}
						warning={entry.doBoth.warning}
						busy={false}
						onSelect={select("do-both", onDoBoth)}
					/>
				)}
			</div>

			{doBothActive && doBoth.step !== "selecting" && (
				<DoBothProgress
					state={doBoth}
					onRetryPull={onRetryPull}
					onRecommendInstead={onRecommendInstead}
					onDismiss={onDismissDoBoth}
				/>
			)}

			{hiddenCount > 0 && (
				<button
					type="button"
					onClick={onShowHidden}
					className="rounded-sm text-primary text-sm underline underline-offset-2 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
				>
					{t("showHidden", { count: hiddenCount })}
				</button>
			)}
		</section>
	);
}
