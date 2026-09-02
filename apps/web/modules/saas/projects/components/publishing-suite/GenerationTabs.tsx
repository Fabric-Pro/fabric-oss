"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	Loader2Icon,
	StarIcon,
} from "lucide-react";
import { useState } from "react";
import type {
	GenerationTabInfo,
	GenerationTabState,
	Restrictions,
} from "./generation-tab-state";
import {
	isRestrictingThread,
	resolveGenerationTabStates,
	resolveRestrictions,
} from "./generation-tab-state";
import type { PlanningAnalysisDocument } from "./planning-analysis-content";
import { ShortPostPanel } from "./ShortPostPanel";
import type { TopicDecisionThread } from "./TopicQuestionsPanel";
import {
	GENERATION_ACTIVE_POST_TYPES,
	POST_TYPE_LABELS,
	type PostType,
} from "./topic-shared";

/**
 * One draft attempt as `listTopicDrafts` returns it (content excluded).
 *
 * Not exported: nothing outside this module names a single attempt — callers
 * pass whole `TopicDraftState` objects — and an export nobody imports is what
 * knip is there to catch.
 */
interface TopicDraftRow {
	id: string;
	postType: PostType;
	version: number;
	status: string;
	error: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	isExpired?: boolean;
	/**
	 * The generated document, `null` until the attempt reaches READY.
	 *
	 * `unknown` rather than a shape: it is `Json?` on the row, and each content
	 * type stores a different document. The panel that renders one is the place
	 * that knows which, so each narrows it for itself — a union here would make
	 * every panel carry the other three's cases.
	 */
	content?: unknown;
}

export interface TopicDraftState {
	postType: PostType;
	latestAttempt: TopicDraftRow | null;
	latestReady: TopicDraftRow | null;
}

export interface TopicWorkingDraftState {
	postType: PostType;
	hasBody: boolean;
	/** The saved draft text. Shared project content, not author-private. */
	body: string;
	/**
	 * Which candidate the body came from. Nullable: the composite FK is
	 * `ON DELETE SET NULL ("sourceDraftId")`, so deleting a candidate keeps the
	 * body and forgets its origin.
	 */
	sourceDraftId: string | null;
	sourceOptionLabel: string | null;
	updatedAt: string | Date;
}

/**
 * The Topic Item Page's content-generation tab strip (Fizzy #1853, Phase 2B-1).
 *
 * Replaces 2A's `GenerationTabsPlaceholder`, whose own comment named itself
 * "the only thing later phases (2B/2C) still need to replace".
 *
 * 2B-1 made the Short Post / Tweet and Blog Post tabs SELECTABLE and gave each a
 * panel showing its recommendation context (FR6/FR7), the unresolved questions
 * that will constrain it (FR8/FR9) and whether a draft exists. 2B-2 added
 * generation for the short post, which is why the Short Post tab now mounts
 * `ShortPostPanel` in place of the generic draft-state block. Blog Post keeps
 * that block until 2B-3, whose contract differs in a way that matters: blog
 * generation seeds a working draft on the first run (FR21) where the short post
 * deliberately does not (DV4), so one component serving both would be a flag
 * deciding which product it is.
 *
 * Case Study and Stakeholder Email stay disabled and still read "Coming soon" —
 * 2A's FR50 still holds for them, and only the two types 2B activates are
 * exempt from it.
 */
export function GenerationTabs({
	projectId,
	organizationId,
	topicId,
	analysis,
	drafts,
	workingDrafts,
	decisionThreads,
	isLoading,
	hasError,
	canEdit,
}: {
	projectId: string;
	organizationId: string | null;
	topicId: string;
	analysis: PlanningAnalysisDocument | null;
	drafts: TopicDraftState[];
	workingDrafts: TopicWorkingDraftState[];
	decisionThreads: TopicDecisionThread[];
	isLoading: boolean;
	/** The drafts read failed. States degrade to AVAILABLE and say so. */
	hasError: boolean;
	/** PR2: a reader sees every panel, and none of the write controls. */
	canEdit: boolean;
}) {
	const [tab, setTab] = useState<PostType>("TWEET");

	const restrictions: Restrictions = resolveRestrictions(decisionThreads);

	// A type counts as generated when it has a READY candidate OR a working
	// draft. A user who saved a body has content for that type whatever became
	// of the candidate it came from.
	const generatedPostTypes = [
		...drafts.filter((d) => d.latestReady !== null).map((d) => d.postType),
		...workingDrafts.filter((w) => w.hasBody).map((w) => w.postType),
	];

	const tabs = resolveGenerationTabStates({
		analysis,
		// A failed read must not invent a generated state. Everything degrades
		// to AVAILABLE and the banner below says the state could not be loaded.
		generatedPostTypes: hasError ? [] : generatedPostTypes,
		restrictions,
	});
	const byPostType = new Map(tabs.map((t) => [t.postType, t]));

	// Only the questions that actually CONSTRAIN a draft, and only named by
	// their subject — never by their full text.
	//
	// Two reasons, and both were found rather than foreseen. First, an open
	// question about authorship does not change what a draft may assert, so
	// listing it here would bury the ones that do — and the predicate is
	// `isRestrictingThread`, shared with the resolver, precisely because an
	// earlier version filtered on the AGGREGATED `restrictions.global` flag.
	// That is a property of the whole thread set, so one safety-critical
	// question let every open thread through, including the authorship ones
	// this filter exists to exclude. Every test fixture happened to hold a
	// single homogeneous kind, so none of them noticed.
	//
	// Second, `TopicQuestionsPanel` on the Summary & Questions tab renders the
	// full question text and the control that ANSWERS it; both panels are
	// mounted at once, so restating the text here put the same sentence on the
	// page twice with only one of them actionable. Naming the subject says what
	// the draft will avoid and leaves answering where the answering happens.
	const restrictingSubjects = decisionThreads
		.filter(isRestrictingThread)
		.map((t) => ({
			id: t.root.id,
			label: t.root.subject ?? humanizeKind(t.root.decisionKind),
		}));

	return (
		<div className="space-y-2">
			<p className="editorial-label">Content generation</p>

			{hasError ? (
				<p
					className="text-muted-foreground text-xs"
					data-testid="generation-tabs-degraded"
				>
					We couldn't load this topic's draft state. The tabs below
					still open, but they can't say what has been generated yet.
				</p>
			) : null}

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as PostType)}
				className="space-y-4"
			>
				<TabsList aria-label="Content generation" className="flex-wrap">
					{POST_TYPE_LABELS.map((t) => {
						const info = byPostType.get(t.value);
						const active = GENERATION_ACTIVE_POST_TYPES.has(
							t.value,
						);
						return (
							<TabsTrigger
								key={t.value}
								value={t.value}
								disabled={!active}
							>
								{t.generationLabel ?? t.label}
								{active && info ? (
									<StateBadge info={info} />
								) : (
									<Badge tone="muted">Coming soon</Badge>
								)}
							</TabsTrigger>
						);
					})}
				</TabsList>

				{POST_TYPE_LABELS.filter((t) =>
					GENERATION_ACTIVE_POST_TYPES.has(t.value),
				).map((t) => {
					const info = byPostType.get(t.value);
					return (
						<TabsContent
							key={t.value}
							value={t.value}
							className="space-y-4"
						>
							<GenerationPanel
								label={t.generationLabel ?? t.label}
								postType={t.value}
								projectId={projectId}
								organizationId={organizationId}
								topicId={topicId}
								canEdit={canEdit}
								info={info ?? null}
								draft={
									drafts.find(
										(d) => d.postType === t.value,
									) ?? null
								}
								working={
									workingDrafts.find(
										(w) => w.postType === t.value,
									) ?? null
								}
								restrictingSubjects={restrictingSubjects}
								isLoading={isLoading}
								hasAnalysis={analysis !== null}
							/>
						</TabsContent>
					);
				})}
			</Tabs>
		</div>
	);
}

const STATE_LABELS: Record<GenerationTabState, string | null> = {
	GENERATED: "Generated",
	NEEDS_CONFIRMATION: "Needs confirmation",
	RECOMMENDED: "Recommended",
	// A type that is available but not recommended "should not be visually
	// promoted" (the card), so it gets no badge. The accessible name below
	// still says "Available", so the state is not invisible to a screen-reader
	// user while being visible to a sighted one.
	AVAILABLE: null,
};

/**
 * The primary state badge, plus the independent caution marker.
 *
 * FR5: state must not rely on colour alone. Every badge carries TEXT and an
 * icon, and because a Radix `TabsTrigger` renders a `<button role="tab">` whose
 * accessible name is its text content, the words become part of what a screen
 * reader announces without any `aria-label` plumbing.
 *
 * The caution marker is rendered SEPARATELY from the primary badge rather than
 * as a fifth state: the four states are exclusive and `GENERATED` outranks the
 * cautious one, so folding them together would silence the warning on exactly
 * the tabs that already have content.
 */
function StateBadge({ info }: { info: GenerationTabInfo }) {
	const label = STATE_LABELS[info.state];
	const showCaution =
		info.needsAttention && info.state !== "NEEDS_CONFIRMATION";

	return (
		<>
			{label ? (
				<Badge
					tone={
						info.state === "GENERATED"
							? "done"
							: info.state === "NEEDS_CONFIRMATION"
								? "warn"
								: "recommend"
					}
				>
					{info.state === "GENERATED" ? (
						<CheckCircle2Icon
							className="size-3"
							aria-hidden="true"
						/>
					) : info.state === "NEEDS_CONFIRMATION" ? (
						<AlertTriangleIcon
							className="size-3"
							aria-hidden="true"
						/>
					) : (
						<StarIcon className="size-3" aria-hidden="true" />
					)}
					{label}
				</Badge>
			) : (
				<span className="sr-only">Available</span>
			)}
			{showCaution ? (
				<Badge tone="warn">
					<AlertTriangleIcon className="size-3" aria-hidden="true" />
					Needs confirmation
				</Badge>
			) : null}
		</>
	);
}

/** "CUSTOMER_NAME" -> "Customer name", for a question that carries no subject. */
function humanizeKind(kind: string | null): string {
	if (!kind || kind === "OTHER") {
		return "An unresolved approval";
	}
	const words = kind.toLowerCase().split("_").join(" ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function Badge({
	tone,
	children,
}: {
	tone: "done" | "warn" | "recommend" | "muted";
	children: React.ReactNode;
}) {
	const toneClass =
		tone === "done"
			? "border-secondary/40 bg-secondary/10 text-secondary"
			: tone === "warn"
				? "border-highlight/40 bg-highlight/10 text-highlight"
				: tone === "recommend"
					? "border-primary/40 bg-primary/10 text-primary"
					: "border-border bg-muted text-muted-foreground";
	return (
		<span
			className={`ml-2 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${toneClass}`}
		>
			{children}
		</span>
	);
}

/**
 * One content type's panel: why it was recommended, what is unresolved, and
 * what has been generated so far.
 */
function GenerationPanel({
	label,
	postType,
	projectId,
	organizationId,
	topicId,
	canEdit,
	info,
	draft,
	working,
	restrictingSubjects,
	isLoading,
	hasAnalysis,
}: {
	label: string;
	postType: PostType;
	projectId: string;
	organizationId: string | null;
	topicId: string;
	canEdit: boolean;
	info: GenerationTabInfo | null;
	draft: TopicDraftState | null;
	working: TopicWorkingDraftState | null;
	restrictingSubjects: { id: string; label: string }[];
	isLoading: boolean;
	hasAnalysis: boolean;
}) {
	if (isLoading) {
		return (
			<p className="text-muted-foreground text-sm">
				Loading draft state…
			</p>
		);
	}

	return (
		<div className="space-y-5">
			<Section label="Recommendation">
				{info?.rationale ? (
					<p className="text-muted-foreground text-sm leading-relaxed">
						{info.rationale}
					</p>
				) : hasAnalysis ? (
					<p className="text-muted-foreground text-sm">
						The planning analysis doesn't say anything about {label}{" "}
						for this topic.
					</p>
				) : (
					<p className="text-muted-foreground text-sm">
						No planning analysis yet — run one on the Planning &amp;
						Analysis tab to get a recommendation.
					</p>
				)}
			</Section>

			{restrictingSubjects.length > 0 ? (
				<Section label="Unresolved before drafting">
					{/* FR8/FR9. Shown rather than used to block: generation
					    will produce a safe, generalized draft and say so, which
					    is what UC4 asks for. Answering happens on the Summary &
					    Questions tab — this only names what is outstanding. */}
					<p className="text-muted-foreground text-sm leading-relaxed">
						These are still unapproved, so a draft will generalize
						rather than assert them:
					</p>
					<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
						{restrictingSubjects.map((r) => (
							<li key={r.id}>{r.label}</li>
						))}
					</ul>
				</Section>
			) : null}

			{postType === "TWEET" ? (
				<ShortPostPanel
					projectId={projectId}
					organizationId={organizationId}
					topicId={topicId}
					draft={draft}
					working={working}
					canEdit={canEdit}
				/>
			) : (
				<>
					<Section label="Draft">
						<DraftState draft={draft} working={working} />
					</Section>

					<p className="rounded-xl border border-border border-dashed bg-muted/40 p-4 text-center text-muted-foreground text-sm">
						Generating {label} arrives in the next release.
					</p>
				</>
			)}
		</div>
	);
}

function DraftState({
	draft,
	working,
}: {
	draft: TopicDraftState | null;
	working: TopicWorkingDraftState | null;
}) {
	const attempt = draft?.latestAttempt ?? null;
	// `isExpired` splits GENERATING in two: a LIVE run is genuinely in flight,
	// a STRANDED one will never report back on its own.
	const isStranded = attempt?.status === "GENERATING" && attempt.isExpired;
	const isGenerating = attempt?.status === "GENERATING" && !isStranded;

	if (isGenerating) {
		return (
			<p
				className="flex items-center gap-2 text-muted-foreground text-sm"
				role="status"
			>
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				A draft is being generated.
			</p>
		);
	}

	if (isStranded) {
		return (
			<p className="text-muted-foreground text-sm" role="alert">
				The last run didn't report back within its time limit.
			</p>
		);
	}

	if (attempt?.status === "FAILED") {
		return (
			<p className="text-muted-foreground text-sm" role="alert">
				{attempt.error ?? "The last draft could not be generated."}
			</p>
		);
	}

	if (working?.hasBody) {
		return (
			<p className="text-muted-foreground text-sm">
				You have a saved draft for this content type.
			</p>
		);
	}

	if (draft?.latestReady) {
		return (
			<p className="text-muted-foreground text-sm">
				Version {draft.latestReady.version} is ready.
			</p>
		);
	}

	return <p className="text-muted-foreground text-sm">No draft yet.</p>;
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
