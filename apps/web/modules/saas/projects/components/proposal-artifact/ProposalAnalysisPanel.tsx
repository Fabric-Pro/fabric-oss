"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import {
	isProposalAnalysisDenied,
	type ProposalAnalysis,
	type ProposalAnalysisFinding,
	useProposalAnalysis,
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

/** Worst first: the order the groups are shown in. */
const SEVERITY_ORDER = ["BLOCKING", "IMPORTANT", "INFORMATIONAL"] as const;

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

const KNOWN_FINDING_TYPES = new Set([
	"SCOPE",
	"COMMERCIAL",
	"ASSUMPTION",
	"RISK",
	"GAP",
	"SOURCE_VALIDATION",
	"ARCHITECTURE",
	"BRANDING",
	"OPPORTUNITY",
]);

/** The findings of one severity, in the order the run produced them. */
function findingsBySeverity(findings: ProposalAnalysisFinding[]) {
	return SEVERITY_ORDER.map((severity) => ({
		severity,
		findings: findings
			.filter((finding) => finding.severity === severity)
			.sort((a, b) => a.position - b.position),
	}));
}

/**
 * The Internal Analysis tab of a Proposal (Fizzy #2801): the newest run's
 * state and, once complete, its findings grouped Blocking, Important,
 * Informational.
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

	let body: ReactNode;
	if (query.isError && isProposalAnalysisDenied(query.error)) {
		// Whatever an earlier answer held stops showing once the server refuses.
		body = (
			<p className="text-muted-foreground text-sm">{t("unavailable")}</p>
		);
	} else if (query.isError && query.data === undefined) {
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
	} else if (query.data === undefined) {
		body = <Progress label={t("loading")} />;
	} else if (query.data === null) {
		body = (
			<p className="text-muted-foreground text-sm">
				{isGenerating
					? t("afterGeneration")
					: awaitingNewRun
						? t("awaiting")
						: t("notRun")}
			</p>
		);
	} else if (isGenerating || (awaitingNewRun && query.data.isStale)) {
		// The previous run stays readable while the next one waits, greyed so
		// nobody mistakes it for an analysis of what is being written now.
		body = (
			<>
				<Alert variant="primary" role="status">
					<AlertDescription className="mt-0">
						{isGenerating
							? t("newRunAfterGeneration")
							: t("awaitingNewRun")}
					</AlertDescription>
				</Alert>
				<div className="opacity-60">
					<AnalysisRun analysis={query.data} showStale={false} />
				</div>
			</>
		);
	} else {
		body = <AnalysisRun analysis={query.data} showStale />;
	}

	return (
		<Card className="space-y-4 p-6">
			<div className="space-y-1">
				<h2 className="font-semibold text-lg tracking-tight">
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>
			{body}
		</Card>
	);
}

/** A spinner beside its label, announced politely as it changes. */
function Progress({ label }: { label: string }) {
	return (
		<output className="flex items-center gap-2 text-muted-foreground text-sm">
			<Loader2Icon
				className="size-4 motion-safe:animate-spin"
				aria-hidden="true"
			/>
			{label}
		</output>
	);
}

function AnalysisRun({
	analysis,
	showStale,
}: {
	analysis: ProposalAnalysis;
	showStale: boolean;
}) {
	const t = useTranslations("projects.proposalArtifact.analysis");

	// Checked before the status: a timed-out run still says PENDING or RUNNING.
	if (analysis.timedOut) {
		return (
			<Alert variant="error" role="status">
				<AlertDescription className="mt-0 space-y-1">
					<p>{t("timedOut")}</p>
					<p>{t("failedHint")}</p>
				</AlertDescription>
			</Alert>
		);
	}

	if (analysis.status === "PENDING") {
		return <Progress label={t("pending")} />;
	}

	if (analysis.status === "RUNNING") {
		return <Progress label={t("running")} />;
	}

	if (analysis.status === "FAILED") {
		const code =
			analysis.errorCode && KNOWN_ERROR_CODES.has(analysis.errorCode)
				? analysis.errorCode
				: "unknown";
		return (
			<Alert variant="error" role="status">
				<AlertDescription className="mt-0 space-y-1">
					<p className="font-medium">{t("failedTitle")}</p>
					<p>{t(`failed.${code}`)}</p>
					<p>{t("failedHint")}</p>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-4">
			{showStale && analysis.isStale && (
				<Alert variant="warning" role="status">
					<AlertDescription className="mt-0">
						{t("stale")}
					</AlertDescription>
				</Alert>
			)}
			{analysis.contextCount === 0 && (
				<p className="text-muted-foreground text-sm">
					{t("noContext")}
				</p>
			)}
			{analysis.findings.length === 0 ? (
				<p className="text-sm">{t("empty")}</p>
			) : (
				<>
					<p className="text-muted-foreground text-sm">
						{t("summary", { count: analysis.findings.length })}
					</p>
					{findingsBySeverity(analysis.findings).map((group) => (
						<SeverityGroup
							key={group.severity}
							severity={group.severity}
							findings={group.findings}
						/>
					))}
				</>
			)}
		</div>
	);
}

function SeverityGroup({
	severity,
	findings,
}: {
	severity: (typeof SEVERITY_ORDER)[number];
	findings: ProposalAnalysisFinding[];
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
						<FindingItem key={finding.id} finding={finding} />
					))}
				</ul>
			)}
		</section>
	);
}

function FindingItem({ finding }: { finding: ProposalAnalysisFinding }) {
	const t = useTranslations("projects.proposalArtifact.analysis");
	const type = KNOWN_FINDING_TYPES.has(finding.type)
		? finding.type
		: "unknown";

	return (
		<li className="rounded-lg border p-3">
			<div className="flex flex-wrap items-start gap-2">
				{/* The type as words, so it never rests on colour alone. */}
				<Badge variant="outline">{t(`type.${type}`)}</Badge>
				<p className="min-w-0 flex-1 font-medium text-sm">
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
		</li>
	);
}
