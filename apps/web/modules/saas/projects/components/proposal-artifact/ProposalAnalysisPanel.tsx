"use client";

import {
	type FindingSeverity,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
} from "@repo/utils/proposal-artifact/finding-constants";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import { FindingEvidence } from "./FindingEvidence";
import {
	AnswerStatus,
	answerAuthorLostRights,
	type FindingControls,
	type FindingDraft,
	FindingResponseControls,
	useFindingControls,
	useFocusAfterAction,
} from "./FindingResponseControls";
import {
	findingNeedsDecision,
	getOrpcErrorData,
	isNewerRunFailed,
	isNewerRunInProgress,
	isProposalAnalysisDenied,
	PROPOSAL_PROMPT_NOT_BOUND_CODE,
	type ProposalAnalysis,
	type ProposalAnalysisFinding,
	type ProposalNewerRun,
	type ProposalNoLongerRaised,
	proposalAnalysisQueryKey,
	useProposalAnalysis,
	useProposalAnalysisActions,
} from "./use-proposal-analysis";

export type ProposalAnalysisPanelProps = {
	projectId: string;
	documentId: string;
	/** The document is QUEUED or GENERATING: a new run follows this one. */
	isGenerating: boolean;
	/**
	 * The latest generation ended and its run is not recorded yet, so what
	 * the server has is either nothing or a run of the previous Main.
	 */
	awaitingNewRun?: boolean;
};

type Translate = ReturnType<typeof useTranslations>;

/**
 * The failure codes a run can carry, each with its own copy. Restated here
 * rather than imported: the temporal and database packages that own them
 * would pull server code into the browser bundle. Anything else reads as the
 * generic failure.
 */
const KNOWN_ERROR_CODES = new Set([
	"AI_PROVIDER_NOT_CONFIGURED",
	"PROMPT_NOT_BOUND",
	"GUEST_TRIGGERED",
	"PROMPT_RENDER_FAILED",
	"MODEL_ERROR",
	"START_FAILED",
	"TIMED_OUT",
]);

/**
 * The finding types with their own copy, from the vocabulary the database
 * and the analysis prompt are tested against. A type the page does not know
 * reads as "unknown" rather than failing to translate.
 */
const KNOWN_FINDING_TYPES: ReadonlySet<string> = new Set(
	PROPOSAL_FINDING_TYPES,
);

/**
 * The findings grouped by severity, worst first, as the server orders the
 * severities. Within a group, those still waiting for a decision come first
 * (unaddressed or needing review), each part in the order the run produced
 * them.
 */
function findingsBySeverity(findings: ProposalAnalysisFinding[]) {
	return PROPOSAL_FINDING_SEVERITIES.map((severity) => ({
		severity,
		findings: findings
			.filter((finding) => finding.severity === severity)
			.sort(
				(a, b) =>
					Number(findingNeedsDecision(b)) -
						Number(findingNeedsDecision(a)) ||
					a.position - b.position,
			),
	}));
}

/**
 * The panel's one polite live region: every change worth hearing — an
 * answer saved, a re-run refused, a run finished — is said here, once.
 * Saying the same sentence twice in a row still announces it, because the
 * text alternates a trailing no-break space. The banners are notes, not
 * alerts, so nothing else in the panel speaks on its own.
 */
function useAnnouncer() {
	const [state, setState] = useState({ message: "", count: 0 });
	const announce = useCallback((message: string) => {
		setState((current) => ({ message, count: current.count + 1 }));
	}, []);
	return {
		announcement: state.message
			? `${state.message}${state.count % 2 ? " " : ""}`
			: "",
		announce,
	};
}

/** Generic copy for a refused re-run; never the server's words. */
function rerunErrorMessage(error: unknown, t: Translate): string {
	const code = getOrpcCode(error);
	const data = getOrpcErrorData(error);
	switch (code) {
		case "TOO_MANY_REQUESTS":
			return data.retryAfter !== undefined
				? t("rerun.rateLimited", {
						minutes: Math.max(1, Math.ceil(data.retryAfter / 60)),
					})
				: t("rerun.rateLimitedLater");
		case "CONFLICT":
			return data.code === "DOCUMENT_GENERATING"
				? t("rerun.conflictGenerating")
				: t("rerun.conflictRunning");
		case "PRECONDITION_FAILED":
			return data.code === PROPOSAL_PROMPT_NOT_BOUND_CODE
				? t("rerun.promptNotBound")
				: t("rerun.failed");
		case "FORBIDDEN":
		case "UNAUTHORIZED":
			return t("rerun.forbidden");
		case "SERVICE_UNAVAILABLE":
			return t("rerun.unavailable");
		default:
			return t("rerun.failed");
	}
}

/**
 * The Internal Analysis tab of a Proposal (Fizzy #2801, Fizzy #2946): the
 * run that describes the current content — or the newest complete one,
 * marked stale — with each finding's state, answer and evidence, the status
 * of any newer run, and the answers to findings no longer raised.
 *
 * A member the server says may respond (`viewer.canRespond`, the rule the
 * write procedures enforce) confirms, answers or clears each finding and
 * re-runs the analysis; nobody else is offered an action. Unsaved answers
 * are held here by stable key, above the run list, so a refetch or a newer
 * run never loses them.
 *
 * Internal review material: the page mounts this only for members of the
 * project's owning organization, and the server refuses everyone else. A
 * refusal renders one neutral line — never the server's message — and stops
 * polling.
 *
 * Every finding field is model output and renders as plain text: React
 * escapes it, and nothing here parses markdown or HTML.
 */
export function ProposalAnalysisPanel({
	projectId,
	documentId,
	isGenerating,
	awaitingNewRun = false,
}: ProposalAnalysisPanelProps) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const query = useProposalAnalysis({
		projectId,
		documentId,
		enabled: true,
	});
	const queryClient = useQueryClient();
	const { announcement, announce } = useAnnouncer();
	const actions = useProposalAnalysisActions({ projectId, documentId });
	const data = query.data;
	const controls = useFindingControls({
		actions,
		runId: data?.run?.id ?? null,
		announce,
	});
	// Where focus lands when the control a member used is gone with
	// everything around it, such as Clear on the last answer no longer raised.
	const headingRef = useRef<HTMLHeadingElement>(null);
	const denied = query.isError && isProposalAnalysisDenied(query.error);
	// The server's answer, not the page's project role: it is the rule every
	// write is checked against, so an action is offered exactly when it would
	// be taken.
	const canRespond = !denied && (data?.viewer.canRespond ?? false);

	useRunAnnouncements(denied ? undefined : data, announce, t);

	// A refused re-run speaks to the analysis as it was when refused; once a
	// run starts or finishes, it no longer applies and is not shown.
	const runsNow = `${data?.run?.id ?? ""}/${data?.newerRun?.id ?? ""}`;
	const [rerunRefusal, setRerunRefusal] = useState<{
		message: string;
		runs: string;
	} | null>(null);
	const rerunError =
		rerunRefusal && rerunRefusal.runs === runsNow
			? rerunRefusal.message
			: null;

	const startRerun = async () => {
		setRerunRefusal(null);
		try {
			await actions.rerun.mutateAsync();
		} catch (error) {
			const message = rerunErrorMessage(error, t);
			// Tied to the runs as they stand when refused: the refetch that
			// follows may already show the run the refusal was about.
			const current = queryClient.getQueryData<ProposalAnalysis>(
				proposalAnalysisQueryKey(projectId, documentId),
			);
			setRerunRefusal({
				message,
				runs: `${current?.run?.id ?? ""}/${current?.newerRun?.id ?? ""}`,
			});
			announce(message);
		}
	};

	const inProgress = isNewerRunInProgress(data);
	const greyed =
		!!data?.run && (isGenerating || (awaitingNewRun && data.isStale));
	const showFailure =
		!!data &&
		!denied &&
		isNewerRunFailed(data) &&
		!isGenerating &&
		!greyed &&
		!(data.run === null && awaitingNewRun);
	const canRerun =
		canRespond &&
		!!data &&
		!denied &&
		(data.run !== null || data.newerRun !== null);

	const rerunControl = canRerun ? (
		<RerunControl
			isGenerating={isGenerating}
			inProgress={inProgress}
			starting={actions.rerun.isPending}
			error={rerunError}
			onRerun={startRerun}
		/>
	) : null;

	let body: ReactNode;
	if (denied) {
		// Whatever an earlier answer held stops showing once the server refuses.
		body = (
			<p className="text-muted-foreground text-sm">{t("unavailable")}</p>
		);
	} else if (query.isError && data === undefined) {
		body = (
			<div className="flex flex-wrap items-center gap-3">
				<p className="text-destructive text-sm">{t("loadFailed")}</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => query.refetch()}
				>
					{t("retry")}
				</Button>
			</div>
		);
	} else if (data === undefined) {
		body = <ProgressLine label={t("loading")} />;
	} else if (data.run === null) {
		if (inProgress && data.newerRun) {
			body = <ProgressLine label={newerRunLabel(data.newerRun, t)} />;
		} else if (isGenerating) {
			body = (
				<p className="text-muted-foreground text-sm">
					{t("afterGeneration")}
				</p>
			);
		} else if (showFailure && data.newerRun) {
			body = (
				<FailedRunAlert newerRun={data.newerRun} hasShownRun={false}>
					{rerunControl}
				</FailedRunAlert>
			);
		} else {
			body = (
				<p className="text-muted-foreground text-sm">
					{awaitingNewRun ? t("awaiting") : t("notRun")}
				</p>
			);
		}
	} else if (greyed) {
		// The previous run stays readable while the next one waits, greyed so
		// nobody mistakes it for an analysis of what is being written now,
		// and read-only: an answer given now would be asked again of the run
		// that follows.
		body = (
			<>
				<Alert variant="primary" role="note">
					<AlertDescription className="mt-0">
						{isGenerating
							? t("newRunAfterGeneration")
							: t("awaitingNewRun")}
					</AlertDescription>
				</Alert>
				<div className="opacity-60">
					<AnalysisRun
						analysis={data}
						interactive={false}
						controls={controls}
						showStale={false}
					/>
				</div>
			</>
		);
	} else {
		body = (
			<AnalysisRun
				analysis={data}
				interactive={canRespond}
				controls={controls}
				focusFallbackRef={headingRef}
				showStale
				failure={
					showFailure && data.newerRun ? (
						<FailedRunAlert newerRun={data.newerRun} hasShownRun>
							{rerunControl}
						</FailedRunAlert>
					) : null
				}
			/>
		);
	}

	return (
		<Card className="space-y-4 p-6">
			<div className="space-y-1">
				<h2
					ref={headingRef}
					// Focusable by script only: see `headingRef`.
					tabIndex={-1}
					className="font-semibold text-lg tracking-tight"
				>
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>
			{showFailure ? null : rerunControl}
			{body}
			<output aria-live="polite" className="sr-only">
				{announcement}
			</output>
		</Card>
	);
}

/**
 * Say in the live region when a newer run starts, fails or completes. The
 * first answer is only the baseline: arriving on the tab is not a change.
 */
function useRunAnnouncements(
	data: ProposalAnalysis | undefined,
	announce: (message: string) => void,
	t: Translate,
) {
	const previous = useRef<{
		runId: string | null;
		newer: "none" | "progress" | "failed";
	} | null>(null);

	useEffect(() => {
		if (!data) {
			return;
		}
		const now = {
			runId: data.run?.id ?? null,
			newer: isNewerRunInProgress(data)
				? ("progress" as const)
				: isNewerRunFailed(data)
					? ("failed" as const)
					: ("none" as const),
		};
		const before = previous.current;
		previous.current = now;
		if (!before) {
			return;
		}
		if (now.newer === "progress" && before.newer !== "progress") {
			announce(t("announce.runStarted"));
		} else if (now.newer === "failed" && before.newer !== "failed") {
			announce(t("announce.runFailed"));
		} else if (now.runId && now.runId !== before.runId) {
			announce(t("announce.runComplete"));
		}
	}, [data, announce, t]);
}

/** A spinner beside its label. Changes are announced by the live region. */
function ProgressLine({ label }: { label: string }) {
	return (
		<p className="flex items-center gap-2 text-muted-foreground text-sm">
			<Loader2Icon
				className="size-4 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			{label}
		</p>
	);
}

/** What a queued or running newer run is doing, in words. */
function newerRunLabel(newerRun: ProposalNewerRun, t: Translate): string {
	if (newerRun.kind === "RERUN") {
		return t("rerunRunning");
	}
	return newerRun.status === "PENDING" ? t("pending") : t("running");
}

/**
 * A newer run that failed or stopped responding. With a complete run shown,
 * its findings stay visible below; the alert says the latest attempt did
 * not complete and offers a re-run.
 */
function FailedRunAlert({
	newerRun,
	hasShownRun,
	children,
}: {
	newerRun: ProposalNewerRun;
	hasShownRun: boolean;
	children?: ReactNode;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	// Checked before the status: a timed-out run still says PENDING or RUNNING.
	const reason = newerRun.timedOut
		? t("timedOut")
		: t(
				`failed.${
					newerRun.errorCode &&
					KNOWN_ERROR_CODES.has(newerRun.errorCode)
						? newerRun.errorCode
						: "unknown"
				}`,
			);

	return (
		<Alert variant="error" role="note">
			<AlertDescription className="mt-0 space-y-2">
				<p className="font-medium">
					{hasShownRun ? t("newerFailedTitle") : t("failedTitle")}
				</p>
				<p>{reason}</p>
				<p>{hasShownRun ? t("newerFailedKept") : t("failedHint")}</p>
				{children}
			</AlertDescription>
		</Alert>
	);
}

/**
 * Re-run the analysis over the current content: idle, starting, running,
 * and a refusal in its own words — rate-limited, already running, the
 * document generating, no prompt bound. Disabled while the document
 * generates, since the generation runs its own analysis.
 */
function RerunControl({
	isGenerating,
	inProgress,
	starting,
	error,
	onRerun,
}: {
	isGenerating: boolean;
	inProgress: boolean;
	starting: boolean;
	error: string | null;
	onRerun: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	return (
		<div className="space-y-1.5">
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => {
					onRerun();
				}}
				disabled={isGenerating || inProgress}
				loading={starting}
			>
				{inProgress ? (
					<>
						<Loader2Icon
							className="motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("rerun.running")}
					</>
				) : starting ? (
					t("rerun.starting")
				) : (
					t("rerun.button")
				)}
			</Button>
			<p className="text-muted-foreground text-xs">{t("rerun.note")}</p>
			{isGenerating ? (
				<p className="text-muted-foreground text-xs">
					{t("rerun.generating")}
				</p>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</div>
	);
}

function AnalysisRun({
	analysis,
	interactive,
	controls,
	focusFallbackRef,
	showStale,
	failure = null,
}: {
	analysis: ProposalAnalysis;
	/** Offer the answer actions: a member with edit rights, not greyed. */
	interactive: boolean;
	controls: FindingControls;
	/** Takes focus when a cleared answer leaves nothing nearer to take it. */
	focusFallbackRef?: RefObject<HTMLElement | null>;
	showStale: boolean;
	/** The alert for a newer run that failed, above the findings. */
	failure?: ReactNode;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	// Held here, not in the group: clearing the last answer no longer raised
	// unmounts the group, and a refused clear brings it back as it was.
	const noLongerRaisedRef = useRef<HTMLDivElement>(null);
	const [noLongerRaisedOpen, setNoLongerRaisedOpen] = useState(false);
	const focusAfter = useFocusAfterAction();
	const clearNoLongerRaised = (index: number, run: () => unknown) =>
		focusAfter(
			run,
			() =>
				noLongerRaisedFocusTarget(noLongerRaisedRef.current, index) ??
				focusFallbackRef?.current,
		);
	const { findings } = analysis;
	const needDecision = findings.filter(findingNeedsDecision).length;
	const shownKeys = new Set(
		findings.flatMap((finding) =>
			finding.keyed && finding.stableKey ? [finding.stableKey] : [],
		),
	);
	const orphanDrafts = interactive
		? [...controls.drafts.values()].filter(
				(draft) => !shownKeys.has(draft.stableKey),
			)
		: [];

	return (
		<div className="space-y-4">
			{showStale && analysis.isStale ? (
				<Alert variant="warning" role="note">
					<AlertDescription className="mt-0">
						{t("stale")}
					</AlertDescription>
				</Alert>
			) : null}
			{showStale &&
			isNewerRunInProgress(analysis) &&
			analysis.newerRun ? (
				<ProgressLine
					label={
						analysis.newerRun.kind === "RERUN"
							? t("newerRerunRunning")
							: t("newerRunning")
					}
				/>
			) : null}
			{failure}
			{analysis.run?.contextCount === 0 ? (
				<p className="text-muted-foreground text-sm">
					{t("noContext")}
				</p>
			) : null}
			{orphanDrafts.length > 0 ? (
				<OrphanDrafts drafts={orphanDrafts} controls={controls} />
			) : null}
			{findings.length === 0 ? (
				<p className="text-sm">{t("empty")}</p>
			) : (
				<>
					<p className="text-muted-foreground text-sm">
						{t("summary", {
							open: needDecision,
							total: findings.length,
						})}
					</p>
					{findingsBySeverity(findings).map((group) => (
						<SeverityGroup
							key={group.severity}
							severity={group.severity}
							findings={group.findings}
							interactive={interactive}
							controls={controls}
						/>
					))}
				</>
			)}
			{analysis.noLongerRaised.length > 0 ? (
				<NoLongerRaisedGroup
					groupRef={noLongerRaisedRef}
					open={noLongerRaisedOpen}
					onOpenChange={setNoLongerRaisedOpen}
					answers={analysis.noLongerRaised}
					interactive={interactive}
					controls={controls}
					onClear={clearNoLongerRaised}
				/>
			) : null}
		</div>
	);
}

function SeverityGroup({
	severity,
	findings,
	interactive,
	controls,
}: {
	severity: FindingSeverity;
	findings: ProposalAnalysisFinding[];
	interactive: boolean;
	controls: FindingControls;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const headingId = useId();

	return (
		<section aria-labelledby={headingId} className="space-y-2">
			<h3
				id={headingId}
				className="flex items-center gap-2 font-medium text-base"
			>
				{t(`severity.${severity}`)}{" "}
				<Badge
					status={
						severity === "BLOCKING"
							? "error"
							: severity === "IMPORTANT"
								? "warning"
								: "info"
					}
				>
					{t("groupCount", { count: findings.length })}
				</Badge>
			</h3>
			{findings.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{t("groupEmpty")}
				</p>
			) : (
				<ul className="space-y-2">
					{findings.map((finding) => (
						<FindingItem
							key={finding.id}
							finding={finding}
							interactive={interactive}
							controls={controls}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function FindingItem({
	finding,
	interactive,
	controls,
}: {
	finding: ProposalAnalysisFinding;
	interactive: boolean;
	controls: FindingControls;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const titleId = useId();
	const type = KNOWN_FINDING_TYPES.has(finding.type)
		? finding.type
		: "unknown";

	return (
		// Focusable by script only: where focus returns after an action when
		// no control of the finding is left to take it.
		<li tabIndex={-1} className="rounded-lg border p-3">
			<div className="flex flex-wrap items-start gap-2">
				{/* The type as words, so it never rests on colour alone. */}
				<Badge variant="outline">{t(`type.${type}`)}</Badge>
				<p id={titleId} className="min-w-0 flex-1 font-medium text-sm">
					{finding.title}
				</p>
			</div>
			<p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed">
				{finding.detail}
			</p>
			{finding.recommendation ? (
				<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
					<span className="font-medium">{t("recommendation")}</span>{" "}
					<span className="whitespace-pre-line">
						{finding.recommendation}
					</span>
				</p>
			) : null}
			{finding.sectionHeading ? (
				<p className="mt-1.5 text-muted-foreground text-xs">
					{t("section", { heading: finding.sectionHeading })}
				</p>
			) : null}
			{finding.foldedTitles.length > 0 ? (
				<p className="mt-1.5 text-muted-foreground text-xs">
					{t("foldedTitles", {
						titles: finding.foldedTitles.join("; "),
					})}
				</p>
			) : null}
			<FindingEvidence evidence={finding.evidence} />
			<FindingResponseControls
				finding={finding}
				controls={controls}
				canEdit={interactive}
				titleId={titleId}
			/>
		</li>
	);
}

/**
 * Drafts whose finding the shown run does not raise. They stay here, as
 * typed, until discarded; if a later run raises the finding again the draft
 * returns to it, to be applied to the current finding.
 */
function OrphanDrafts({
	drafts,
	controls,
}: {
	drafts: FindingDraft[];
	controls: FindingControls;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const headingId = useId();

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-2 rounded-lg border border-border p-3"
		>
			<h3 id={headingId} className="font-medium text-base">
				{t("orphan.title")}
			</h3>
			<p className="text-muted-foreground text-sm">
				{t("orphan.description")}
			</p>
			<ul className="space-y-2">
				{drafts.map((draft) => (
					<li key={draft.stableKey} className="space-y-1">
						<p className="font-medium text-sm">
							{t("orphan.writtenFor", {
								title: draft.findingTitle,
							})}
						</p>
						<p className="whitespace-pre-line rounded-md bg-muted/40 p-2 text-sm">
							{draft.text}
						</p>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() =>
								controls.discardDraft(draft.stableKey)
							}
						>
							{t("orphan.discard")}
						</Button>
					</li>
				))}
			</ul>
		</section>
	);
}

/**
 * Where focus goes once an answer under "No longer raised" is cleared and
 * its item has gone: the Clear of the answer now in its place, else of the
 * one before it when it was last, else the group's trigger. Null once the
 * group has gone with its last answer.
 */
function noLongerRaisedFocusTarget(
	group: HTMLElement | null,
	index: number,
): HTMLElement | null {
	if (!group) {
		return null;
	}
	const items = group.querySelectorAll<HTMLElement>(
		"[data-slot='collapsible-content'] li",
	);
	const item = items[Math.min(index, items.length - 1)];
	return (
		item?.querySelector<HTMLElement>("button:not(:disabled)") ??
		group.querySelector<HTMLElement>("[data-slot='collapsible-trigger']")
	);
}

/**
 * Answers to findings the shown run does not raise, collapsed: each with
 * the finding's title as answered, its kind and text, its derived state and
 * Clear. They still steer later generations unless they need review or
 * their author no longer holds edit rights, which each such answer says.
 *
 * Clearing one removes it at once, taking the focused Clear with it; once
 * the clear settles, `onClear` moves focus to the nearest answer's Clear,
 * the group's trigger, or a target outside the group when none is left.
 */
function NoLongerRaisedGroup({
	groupRef,
	open,
	onOpenChange,
	answers,
	interactive,
	controls,
	onClear,
}: {
	groupRef: RefObject<HTMLDivElement | null>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	answers: ProposalNoLongerRaised[];
	interactive: boolean;
	controls: FindingControls;
	/** Wraps the clear of the answer at `index` to place focus after it. */
	onClear: (index: number, run: () => unknown) => () => Promise<void>;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");

	return (
		<Collapsible
			ref={groupRef}
			open={open}
			onOpenChange={onOpenChange}
			className="space-y-2"
		>
			<h3 className="font-medium text-base">
				<CollapsibleTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="[&[data-state=open]>svg]:rotate-90"
					>
						<ChevronRightIcon aria-hidden="true" />
						{t("noLongerRaised.title", { count: answers.length })}
					</Button>
				</CollapsibleTrigger>
			</h3>
			<CollapsibleContent className="space-y-2">
				<p className="text-muted-foreground text-sm">
					{t("noLongerRaised.description")}
				</p>
				<ul className="space-y-2">
					{answers.map((answer, index) => (
						<NoLongerRaisedItem
							key={answer.stableKey}
							answer={answer}
							interactive={interactive}
							controls={controls}
							onClear={(run) => onClear(index, run)}
						/>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}

function NoLongerRaisedItem({
	answer,
	interactive,
	controls,
	onClear,
}: {
	answer: ProposalNoLongerRaised;
	interactive: boolean;
	controls: FindingControls;
	onClear: (run: () => unknown) => () => Promise<void>;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const titleId = useId();
	const saving = controls.pendingKeys.has(answer.stableKey);
	const error = controls.errors.get(answer.stableKey);

	return (
		<li className="space-y-2 rounded-lg border p-3">
			<p id={titleId} className="font-medium text-sm">
				{answer.findingTitle}
			</p>
			<AnswerStatus
				state={answer.state}
				reason={answer.reason}
				response={answer.response}
				saving={saving}
				authorLostRights={answerAuthorLostRights(
					answer.response,
					answer.state === "NEEDS_REVIEW",
				)}
			/>
			{interactive ? (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={saving}
					aria-describedby={titleId}
					onClick={onClear(() =>
						controls.clearAnswer(answer.stableKey, {
							responseId: answer.response.id,
							version: answer.response.version,
						}),
					)}
				>
					{t("actions.clear")}
				</Button>
			) : null}
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
		</li>
	);
}
