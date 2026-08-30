"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { AlertTriangleIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import {
	isEmptyAnalysis,
	type PlanningQuestion,
	readPlanningAnalysis,
} from "./planning-analysis-content";

/** One analysis row as `getPlanningAnalysis` returns it. */
export interface PlanningAnalysisRow {
	id: string;
	version: number;
	status: string;
	content: unknown;
	sourceRefs: unknown;
	model: string | null;
	promptSource: string | null;
	error: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	/**
	 * Server-computed: a GENERATING row past its deadline that nothing
	 * terminalised. The panel must treat it as retryable — the only code that
	 * reclaims such a row runs inside the NEXT attempt, so a button disabled on
	 * `status === "GENERATING"` alone locks the topic permanently.
	 */
	isExpired?: boolean;
}

/**
 * The topic's planning worksheet (Fizzy #1851, Phase 2A-2).
 *
 * Takes TWO rows, not one, and the reason is the only interesting thing about
 * this component: `latestReady` is what to render, `latestAttempt` is what to
 * say about it. A panel driven off "the newest row" would blank a perfectly
 * good analysis the moment a regeneration failed, and hide it again for the
 * minutes the next one runs — precisely when its reader most wants the last
 * good one.
 *
 * Data is fetched by the page rather than here, so the Summary & Questions tab
 * can render the same questions (FR39) from the same cache entry without a
 * second poll.
 */
export function PlanningAnalysisTab({
	projectId,
	topicId,
	organizationId,
	canEdit,
	isLoading,
	latestAttempt,
	latestReady,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
	isLoading: boolean;
	latestAttempt: PlanningAnalysisRow | null;
	latestReady: PlanningAnalysisRow | null;
}) {
	const queryClient = useQueryClient();

	const generate = useMutation(
		orpc.projects.publishingSuite.generatePlanningAnalysis.mutationOptions({
			onSuccess: (result: { started: boolean; reason?: string }) => {
				if (!result.started && result.reason === "unavailable") {
					toast.error(
						"Generation is temporarily unavailable. Please try again shortly.",
					);
				}
				// Even an "in-progress" answer wants the refetch: it means a row
				// exists that this client has not seen yet, and the page's poll
				// keys off exactly that row's status.
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.getPlanningAnalysis.queryKey(
							{
								input: { projectId, topicId, organizationId },
							},
						),
				});
			},
			onError: () => {
				toast.error("Could not start the planning analysis.");
			},
		}),
	);

	// `isExpired` splits GENERATING in two. A LIVE run keeps the button disabled
	// — a second click spends a second model call on a healthy run. A STRANDED
	// one must re-enable it, because pressing it is the only thing that reaches
	// the reclaim inside `startPlanningAnalysisAttempt`.
	const isStranded =
		latestAttempt?.status === "GENERATING" &&
		latestAttempt.isExpired === true;
	const isGenerating = latestAttempt?.status === "GENERATING" && !isStranded;
	const hasFailed = latestAttempt?.status === "FAILED";
	const canRetry = hasFailed || isStranded;
	// A ready row that is NOT the newest attempt is a previous analysis being
	// shown while a newer attempt runs or after one failed.
	const readyIsStale =
		latestReady != null &&
		latestAttempt != null &&
		latestReady.id !== latestAttempt.id;

	const onGenerate = () =>
		generate.mutate({ projectId, topicId, organizationId });

	if (isLoading) {
		return (
			<p className="text-muted-foreground text-sm">
				Loading planning analysis…
			</p>
		);
	}

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="editorial-label">Planning &amp; analysis</p>
				{canEdit ? (
					<Button
						variant={latestReady ? "outline" : "primary"}
						size="sm"
						onClick={onGenerate}
						disabled={isGenerating || generate.isPending}
					>
						{isGenerating || generate.isPending ? (
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<SparklesIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
						)}
						{canRetry
							? "Try again"
							: latestReady
								? "Regenerate planning analysis"
								: "Generate planning analysis"}
					</Button>
				) : null}
			</div>

			{isGenerating ? (
				<Banner tone="info">
					Generating the planning analysis. This usually takes a
					minute or two.
				</Banner>
			) : null}

			{hasFailed ? (
				<Banner tone="error">
					{latestAttempt?.error ??
						"The planning analysis could not be built."}
				</Banner>
			) : null}

			{isStranded ? (
				<Banner tone="error">
					This run did not report back within its time limit.
					Generating again will clear it and start a new one.
				</Banner>
			) : null}

			{latestReady ? (
				<AnalysisBody row={latestReady} isStale={readyIsStale} />
			) : isGenerating || canRetry ? null : (
				<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
					No planning analysis yet.
					{canEdit
						? " Generate one to see the angle, key details, recommended content types and the decisions that still need an answer."
						: ""}
				</p>
			)}
		</div>
	);
}

function Banner({
	tone,
	children,
}: {
	tone: "info" | "error";
	children: React.ReactNode;
}) {
	const isError = tone === "error";
	return (
		<p
			className={
				isError
					? "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm"
					: "flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-muted-foreground text-sm"
			}
			role={isError ? "alert" : "status"}
		>
			{isError ? (
				<AlertTriangleIcon
					className="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
			) : (
				<Loader2Icon
					className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			)}
			<span>{children}</span>
		</p>
	);
}

function AnalysisBody({
	row,
	isStale,
}: {
	row: PlanningAnalysisRow;
	isStale: boolean;
}) {
	const doc = readPlanningAnalysis(row.content);

	if (isEmptyAnalysis(doc)) {
		return (
			<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
				This analysis came back empty. The topic's sources may not carry
				enough to plan from yet.
			</p>
		);
	}

	return (
		<div className="space-y-6">
			{isStale ? (
				<p className="text-muted-foreground text-xs">
					Showing the previous analysis (version {row.version}).
				</p>
			) : null}

			{doc.prose.map((section) => (
				<Section key={section.key} label={section.label}>
					<Markdown>{section.body}</Markdown>
				</Section>
			))}

			{doc.keyDetails.length > 0 ? (
				<Section label="Key details">
					<dl className="space-y-3">
						{doc.keyDetails.map((d) => (
							<div key={d.key}>
								<dt className="font-medium text-foreground text-sm">
									{d.label}
								</dt>
								<dd className="text-muted-foreground text-sm leading-relaxed">
									{d.body}
								</dd>
							</div>
						))}
					</dl>
				</Section>
			) : null}

			{doc.buckets.map((section) => (
				<Section key={section.key} label={section.label}>
					<div className="space-y-4">
						{section.buckets.map((bucket) => (
							<div key={bucket.key} className="space-y-1.5">
								<p className="font-medium text-foreground text-sm">
									{bucket.label}
								</p>
								<ul className="space-y-1.5">
									{bucket.items.map((item) => (
										<li
											key={`${item.type}-${item.rationale}`}
											className="text-sm leading-relaxed"
										>
											<span className="text-foreground">
												{item.type}
											</span>
											<span className="text-muted-foreground">
												{" "}
												— {item.rationale}
											</span>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</Section>
			))}

			{doc.risks.length > 0 ? (
				<Section label="Risks">
					<BulletList items={doc.risks} />
				</Section>
			) : null}

			{doc.sourceSignals.length > 0 ? (
				<Section label="Source signals">
					<BulletList items={doc.sourceSignals} />
				</Section>
			) : null}

			{doc.preDraftGuidance ? (
				<Section label="Before drafting">
					<Markdown>{doc.preDraftGuidance}</Markdown>
				</Section>
			) : null}

			<Provenance row={row} />
		</div>
	);
}

function Section({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<h3 className="editorial-label">{label}</h3>
			{children}
		</section>
	);
}

function BulletList({ items }: { items: string[] }) {
	return (
		<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
			{items.map((item) => (
				<li key={item}>{item}</li>
			))}
		</ul>
	);
}

/**
 * How this analysis was built.
 *
 * The prompt note is the load-bearing part: an analysis built from the default
 * body because a bound prompt would not render reads exactly like one built
 * from the bound prompt, so it is the one fact about a run a reader cannot
 * recover from the output itself.
 */
function Provenance({ row }: { row: PlanningAnalysisRow }) {
	const usedDefault =
		row.promptSource === "DEFAULT_UNBOUND" ||
		row.promptSource === "DEFAULT_RENDER_FAILED";
	return (
		<p className="border-border border-t pt-3 text-muted-foreground text-xs">
			Version {row.version}
			{row.model ? ` · ${row.model}` : ""}
			{usedDefault
				? row.promptSource === "DEFAULT_RENDER_FAILED"
					? " · built from the default prompt (the bound prompt did not render)"
					: " · built from the default prompt"
				: ""}
		</p>
	);
}

/**
 * The open questions, read-only (FR39).
 *
 * Rendered by the Summary & Questions tab as well as by the worksheet, from the
 * same parsed document — which is what stops the two surfaces disagreeing about
 * which decisions are still open. Answering them is 2A-3's job; this phase's
 * obligation is that a decision the analysis flagged is never invisible.
 */
export function TopicOpenQuestions({
	questions,
}: {
	questions: PlanningQuestion[];
}) {
	if (questions.length === 0) {
		return null;
	}
	return (
		<section className="space-y-3">
			<h3 className="editorial-label">Open questions</h3>
			<ul className="space-y-3">
				{questions.map((q) => (
					<li
						key={q.questionId}
						className="rounded-lg border border-border bg-card p-4"
					>
						<p className="text-foreground text-sm leading-relaxed">
							{q.question}
						</p>
						{q.recommendedResponse ? (
							<p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
								Suggested: {q.recommendedResponse}
							</p>
						) : null}
						{q.whyItMatters ? (
							<p className="mt-1.5 text-muted-foreground text-xs leading-relaxed">
								{q.whyItMatters}
							</p>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}
