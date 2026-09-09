"use client";

import {
	type EffectiveAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Markdown } from "@ui/components/markdown";
import {
	AlertTriangleIcon,
	HistoryIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnalysisVersionHistory } from "./AnalysisVersionHistory";
import { PlanningAnalysisEditor } from "./PlanningAnalysisEditor";
import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "./planning-analysis-content";
import {
	liveAnswerReply,
	type TopicDecisionThread,
} from "./TopicQuestionsPanel";

const UNKNOWN_AUTHOR_LABEL = "Unknown author";
const REPLACE_FAILURE_MESSAGE =
	"Could not replace the analysis. Refresh and try again.";

/**
 * One analysis row as `getPlanningAnalysis` returns it. Local: no other
 * module needs it, because no other module is given the raw AI row.
 */
interface PlanningAnalysisRow {
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

interface SaveAnalysisRevisionResult {
	saved: true;
	version: number;
}

interface PlanningAnalysisTabProps {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
	isLoading: boolean;
	/**
	 * A rewrite the AI assistant produced and the reader accepted in the chat
	 * (Fizzy #1851, #15). `null` whenever there is none waiting.
	 *
	 * It arrives as a SEED for the editor, never as a save: this tab has no
	 * autosave, and the reason is #1929 — an autosave racing an in-flight agent
	 * overwrote the server with pre-answer text. A second writer here would
	 * reintroduce exactly that race against a document whose revisions are
	 * defined as "what a person saved". So the assistant's text lands in the
	 * editor and the existing Save stays the only thing that writes.
	 */
	assistantProposal?: string | null;
	/** Clears the parent's copy, so one accepted rewrite is applied once. */
	onAssistantProposalConsumed?: () => void;
	/**
	 * The newest attempt at an analysis, whatever became of it. This is what
	 * the panel says ABOUT the document — running, failed, stranded past its
	 * deadline — never what it renders. A panel driven off "the newest row"
	 * would blank a perfectly good analysis the moment a regeneration failed,
	 * and hide it again for the minutes the next one runs.
	 */
	latestAttempt: PlanningAnalysisRow | null;
	/**
	 * What to RENDER: the resolver's one answer to "what is this topic's
	 * planning analysis right now" — the AI's own prose, or the author's
	 * override of it, plus the structured data half either way. `null` when no
	 * READY analysis exists at all.
	 */
	effective: EffectiveAnalysis | null;
	/** Version of the newest READY analysis. `null` when there is none. */
	aiVersion: number | null;
	/**
	 * When the newest READY analysis was written. `null` when there is none.
	 *
	 * Separate from `aiVersion` because the two answer different questions: a
	 * version says WHICH document this is, a timestamp says what it could
	 * possibly have known. Only the second one survives an amendment, which
	 * moves an answer without moving any version.
	 */
	aiCreatedAt: string | Date | null;
	/**
	 * The topic's decision threads, read only to count answers the current
	 * analysis predates. The panel that renders them lives on another tab; this
	 * tab needs the COUNT so it can say the document is behind them.
	 */
	decisionThreads?: TopicDecisionThread[];
	/**
	 * The model that produced the newest READY analysis, and how that run's
	 * prompt was resolved. Scalars off that row rather than the row itself:
	 * provenance has to survive a FAILED or stranded attempt landing on top of
	 * a good analysis, and both of those are terminal states — a footer that
	 * read them off `latestAttempt` would drop them for good, on exactly the
	 * analyses a reader is most likely to be scrutinising.
	 */
	aiModel: string | null;
	aiPromptSource: string | null;
	/** Version of the current hand-edited revision. `null` before the first. */
	revisionVersion: number | null;
	/** The analysis version the current document was written from. */
	sourceAnalysisVersion: number | null;
	/** Who wrote the current revision; `null` for a departed author. */
	author: { id: string; name: string } | null;
	/** Arrives as a `Date` over the oRPC contract, not a string. */
	revisionCreatedAt: string | Date | null;
}

/**
 * The topic's Planning & Analysis tab (Fizzy #1851).
 *
 * Composes the editable document (`PlanningAnalysisEditor`, Task 9) and its
 * version history (`AnalysisVersionHistory`, Task 10) around the structured
 * sections the product reads by name, in one order: header (label, History,
 * Generate, and the provenance line under them), stale banner, document, data
 * sections.
 *
 * Three things here are load-bearing rather than cosmetic:
 *
 *  1. **The editor is remounted on a seed change, and only on one.** It seeds
 *     its `prose` prop on mount and has no re-sync effect, so a restore, a
 *     replace, or a regeneration landing on a document nobody has edited all
 *     have to force a fresh mount — a prop update alone would leave the author
 *     reading text the server no longer holds. An ordinary Save is the
 *     opposite case: the editor's own buffer already IS the saved text, and
 *     remounting would reset the cursor, drop the undo stack, and discard
 *     anything typed between the save and the refetch landing. With no
 *     autosave here, "save and keep typing" is the normal way to work. See
 *     `seed` below for the one rule that separates the two.
 *  2. **Every write invalidates the analysis query.** The editor's version
 *     props are controlled with no internal state update on success, so a
 *     second Save before this parent re-renders with fresh props would resend
 *     a stale `expectedVersion` and earn a spurious CONFLICT.
 *  3. **"Replace" goes through the same save path as any other edit.** It
 *     writes a new revision seeded from the newer AI prose rather than
 *     deleting the author's, so it lands in history and rolls back like
 *     anything else.
 *
 * Data is fetched by the page rather than here: `latestAttempt`'s status also
 * drives the Summary & Questions tab's `TopicQuestionsPanel`, which explains a
 * failed regeneration (`analysisFailed`) rather than rendering as though
 * nothing was ever raised — so both tabs need the same row from one poll.
 */
export function PlanningAnalysisTab({
	projectId,
	topicId,
	organizationId,
	canEdit,
	isLoading,
	latestAttempt,
	effective,
	aiVersion,
	aiCreatedAt,
	decisionThreads,
	aiModel,
	aiPromptSource,
	revisionVersion,
	sourceAnalysisVersion,
	author,
	revisionCreatedAt,
	assistantProposal = null,
	onAssistantProposalConsumed,
}: PlanningAnalysisTabProps) {
	const queryClient = useQueryClient();
	const [historyOpen, setHistoryOpen] = useState(false);
	const [newerOpen, setNewerOpen] = useState(false);

	/**
	 * What the MOUNTED editor was seeded from, and the token that remounts it.
	 *
	 * `generation` is the editor's `key`, so bumping it destroys the TipTap
	 * instance and rebuilds it from the prose now in props. `revision` and `ai`
	 * are what that instance was actually built from — deliberately not "what
	 * the server holds now", which is what makes the comparison below mean
	 * something.
	 */
	const [seed, setSeed] = useState<{
		topic: string;
		revision: number | null;
		ai: number | null;
		generation: number;
	}>(() => ({
		topic: topicId,
		revision: revisionVersion,
		ai: aiVersion,
		generation: 0,
	}));
	/**
	 * The revision this editor's own Save produced, and the topic it produced
	 * it on. A version the editor itself wrote is never a reason to re-seed it:
	 * the text is already on screen, in the instance the author is still typing
	 * into.
	 *
	 * The TOPIC half is what keeps that exemption honest, and it cannot be
	 * recovered from `seed.topic`: by the time a revision arrives on a new
	 * topic, the topic-swing remount has already advanced the seed to it. A
	 * bare version number would then match across topics — and it would match
	 * routinely rather than rarely, because every topic's first revision is
	 * version 1. The consequence is not cosmetic: the exempted refetch leaves
	 * the editor showing the new topic's un-edited AI prose while
	 * `revisionVersion` says a revision exists, so the next Save sends an
	 * `expectedVersion` the server accepts and supersedes somebody else's
	 * revision with neither person seeing it.
	 *
	 * This is only ONE of the two topic terms `isOwnSave` needs. Nothing ever
	 * clears this record, so it also has to be paired with `seed.topic` — see
	 * the comment there for the question that term answers instead.
	 */
	const [ownSave, setOwnSave] = useState<{
		topic: string;
		version: number;
	} | null>(null);

	/**
	 * The assistant's rewrite once it is IN the editor — kept so the editor can
	 * be seeded from it instead of from the server's prose, and so the notice
	 * above it knows to be there.
	 *
	 * Cleared by a save (the text is the document now) and by Discard.
	 */
	const [loadedProposal, setLoadedProposal] = useState<string | null>(null);

	// Every write that can move the document's version has to land here. The
	// editor and the history drawer both hold their version tokens as props
	// from this parent, and neither updates them itself on success.
	//
	// TWO queries, because a save moves two things: the document, and the list
	// of versions the document has had. Only the first was invalidated, so
	// saving an edit left History showing a list without the revision it had
	// just written — and the global 60s `staleTime` meant reopening the drawer
	// did not refetch either, which is why it took a full page reload to
	// appear. Restore already invalidated both; an ordinary Save did not.
	//
	// `key()` and NOT `queryKey()` for the revision list, for the reason its
	// own restore handler documents at length: the list is an INFINITE query,
	// `queryKey({ input })` stamps `type: "query"`, and the mismatch matches
	// nothing at runtime while looking perfectly correct here.
	const refreshAnalysis = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey:
				orpc.projects.publishingSuite.getPlanningAnalysis.queryKey({
					input: { projectId, topicId, organizationId },
				}),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listAnalysisRevisions.key({
				input: { projectId, topicId, organizationId },
			}),
		});
	}, [queryClient, projectId, topicId, organizationId]);

	// A save is the one write whose result the editor already has. Recording
	// the version it produced is what keeps the refetch that follows from
	// remounting the instance the author is still typing into. It records
	// BEFORE the refetch lands, so the props that arrive carrying that version
	// are recognised the moment they do — and it records the topic it was made
	// on, which is the only thing that stops the same number being honoured on
	// a different one.
	const handleSaved = useCallback(
		(version: number) => {
			setOwnSave({ topic: topicId, version });
			// The assistant's text is the document now, so the notice offering
			// to discard it no longer describes anything true.
			setLoadedProposal(null);
			refreshAnalysis();
		},
		[refreshAnalysis, topicId],
	);

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
				refreshAnalysis();
			},
			onError: () => {
				toast.error("Could not start the planning analysis.");
			},
		}),
	);

	const replace = useMutation(
		orpc.projects.publishingSuite.saveAnalysisRevision.mutationOptions({
			onSuccess: (result: SaveAnalysisRevisionResult) => {
				toast.success(
					`Replaced with analysis version ${aiVersion} (saved as version ${result.version}).`,
				);
				setNewerOpen(false);
				refreshAnalysis();
			},
			onError: () => {
				toast.error(REPLACE_FAILURE_MESSAGE);
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

	// The newest attempt IS the newest READY row whenever nothing newer has
	// been tried. That is the only way this component ever holds the raw AI
	// content: `latestReady` is deliberately no longer part of the response,
	// because a caller that rendered it would silently ignore the author's own
	// edit. Here the row is never rendered as the document — it is the SEED for
	// "replace with the newer analysis", and nothing else. Provenance does NOT
	// come from here; it arrives as `aiModel` / `aiPromptSource`, which survive
	// a failed attempt landing on top of a good analysis.
	const readyRow =
		latestAttempt != null &&
		latestAttempt.status === "READY" &&
		aiVersion != null &&
		latestAttempt.version === aiVersion
			? latestAttempt
			: null;

	// A ready analysis that is NOT the newest attempt is a previous one being
	// shown while a newer attempt runs or after one failed.
	const showingPrevious =
		aiVersion != null &&
		latestAttempt != null &&
		latestAttempt.version !== aiVersion;

	// The author's document was written from an analysis the AI has since moved
	// past. Both halves must be known — a document nobody has edited reports
	// `sourceAnalysisVersion === aiVersion` and is never stale.
	const isStale =
		sourceAnalysisVersion !== null &&
		aiVersion !== null &&
		sourceAnalysisVersion < aiVersion;

	// Has the document moved out from under the mounted editor?
	//
	// Three ways it can, and all three must remount: this is a different topic
	// (the page reuses one mounted tab across topics), a different revision is
	// now current (a restore, a replace, or someone else's edit arriving on a
	// poll), or — on a document nobody has ever edited — a newer analysis went
	// READY, which replaces `effective.prose` wholesale. Missing the last is
	// how an editor ends up rendering version 1's text directly beside a footer
	// that says "showing analysis version 2".
	//
	// The one thing that is NOT a move: a version this editor's own Save just
	// produced. That is the whole difference between "the text changed" and "I
	// changed the text", and it has to exempt that one refetch and nothing
	// else.
	//
	// It takes BOTH topic terms. They are not redundant — they answer two
	// different questions, and deleting either one reopens a different defect:
	//
	//  * `topicId === ownSave.topic` asks "is this revision MINE?" Without it
	//    the exemption remembers a bare version NUMBER, and every topic's first
	//    revision is version 1 — so a save made here lines up with the first
	//    revision anybody writes over there as a matter of course. That refetch
	//    is exempted, the editor keeps showing the other topic's un-edited AI
	//    prose, and the next Save supersedes a colleague's revision with
	//    neither person seeing it. `seed.topic` cannot stand in for this: the
	//    topic-swing remount has already advanced the seed onto the arriving
	//    revision's own topic by the time it lands.
	//  * `topicId === seed.topic` asks "is the MOUNTED editor already on this
	//    topic?" `ownSave` is never cleared, so after a save on topic-1 and a
	//    swing away to topic-2, swinging BACK to topic-1 on that same version
	//    number still matches the save. Without this term the exemption holds,
	//    nothing remounts, and the editor keeps topic-2's document while
	//    `topicId`, `revisionVersion`, `sourceAnalysisVersion` and the footer
	//    are all topic-1's — so the next Save writes topic-2's prose into
	//    topic-1's revision chain at an `expectedVersion` the server accepts.
	//    No CONFLICT, no warning, and no second actor required.
	const isOwnSave =
		ownSave !== null &&
		topicId === ownSave.topic &&
		topicId === seed.topic &&
		revisionVersion !== null &&
		revisionVersion === ownSave.version;
	const seedIsStale =
		!isOwnSave &&
		(topicId !== seed.topic ||
			revisionVersion !== seed.revision ||
			(revisionVersion === null && aiVersion !== seed.ai));
	if (seedIsStale) {
		// Adjusting state during render — React's own pattern for state that
		// derives from props. It re-runs this render with the new seed before
		// anything commits, so the editor mounts once, on the right key.
		setSeed({
			topic: topicId,
			revision: revisionVersion,
			ai: aiVersion,
			generation: seed.generation + 1,
		});
	}

	const newerProse = readyRow ? renderAnalysisProse(readyRow.content) : null;

	const onGenerate = () =>
		generate.mutate({ projectId, topicId, organizationId });

	/**
	 * Start the first analysis when this tab is opened on a topic that has
	 * never had one.
	 *
	 * The tab used to open on an empty dashed box with a button, and the owner's
	 * complaint was that there is nothing to work with there — every other tab
	 * on the page depends on this document, so the first thing anyone does on
	 * arriving is press Generate. Feature Maturation drafts its spec at creation
	 * for the same reason.
	 *
	 * The conditions are narrow on purpose, because this spends an LLM call:
	 *
	 *  - `latestAttempt === null` — NEVER attempted, not merely "no READY row".
	 *    A failed or stranded run has already cost money and its retry is a
	 *    decision for the person looking at the failure, not for a mount.
	 *  - `canEdit` — the server gates generation, so a reader must not fire a
	 *    request that can only 403.
	 *  - `!isLoading` — before the query settles, `latestAttempt` is null
	 *    because nothing has been read yet, which is a different thing from
	 *    nothing existing.
	 *
	 * The ref guard is load-bearing rather than defensive. `generate.mutate`
	 * invalidates the analysis query, the refetch re-renders this component,
	 * and for the moment before the new row lands `latestAttempt` is still
	 * null — so without it this effect re-enters and starts a second run.
	 *
	 * Radix unmounts inactive tab content, so "mount" IS "opened" and this
	 * cannot fire for someone who never visits the tab.
	 */
	const autoStarted = useRef(false);
	useEffect(() => {
		if (
			autoStarted.current ||
			isLoading ||
			!canEdit ||
			latestAttempt !== null ||
			generate.isPending
		) {
			return;
		}
		autoStarted.current = true;
		onGenerate();
	}, [isLoading, canEdit, latestAttempt, generate.isPending, onGenerate]);

	/**
	 * Take the assistant's accepted rewrite into the editor.
	 *
	 * The generation bump is what makes it visible: `PlanningAnalysisEditor`
	 * seeds its TipTap instance on mount and never re-syncs, so feeding it new
	 * prose without remounting it changes nothing on screen. The functional
	 * form matters too — the render-phase `setSeed` above may have fired in the
	 * same commit, and a bump computed from the `seed` this closure captured
	 * would land on the stale generation and cancel that remount out.
	 *
	 * Taken ONCE, and the guard is the proposal's own text rather than the
	 * effect's dependency list: `onAssistantProposalConsumed` is a prop, and a
	 * caller that rebuilds it per render would otherwise re-fire this on every
	 * poll — re-seeding the editor and destroying everything typed since the
	 * accept. Clearing the parent is the other half, not a substitute for it.
	 */
	const consumedProposal = useRef<string | null>(null);
	useEffect(() => {
		if (assistantProposal === null) {
			// Re-arm, so proposing the SAME text again after a clear is a new
			// proposal rather than one the guard below silently swallows.
			consumedProposal.current = null;
			return;
		}
		if (consumedProposal.current === assistantProposal) {
			return;
		}
		consumedProposal.current = assistantProposal;
		setLoadedProposal(assistantProposal);
		setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
		onAssistantProposalConsumed?.();
	}, [assistantProposal, onAssistantProposalConsumed]);

	/** Put the server's text back, and remount the editor onto it. */
	const discardProposal = useCallback(() => {
		setLoadedProposal(null);
		setSeed((prev) => ({ ...prev, generation: prev.generation + 1 }));
	}, []);

	const onReplace = () => {
		if (newerProse === null || aiVersion === null) {
			return;
		}
		replace.mutate({
			projectId,
			topicId,
			organizationId,
			body: newerProse,
			// The compare-and-set token: where the document is NOW.
			expectedVersion: revisionVersion,
			// The whole point of replacing — the new revision is stamped with
			// the analysis it was actually seeded from, which is what clears
			// the stale banner.
			sourceAnalysisVersion: aiVersion,
			changeSummary: `Replaced with analysis version ${aiVersion}`,
		});
	};

	if (isLoading) {
		return (
			<p className="text-muted-foreground text-sm">
				Loading planning analysis…
			</p>
		);
	}

	const data = effective ? readPlanningAnalysis(effective.data) : null;
	const proseIsEmpty = effective !== null && effective.prose.trim() === "";

	/**
	 * Answers the current analysis does not know about.
	 *
	 * Compares TIMESTAMPS, not versions: an answer that landed after the
	 * document was written is one the document cannot reflect, whatever
	 * version either of them carries.
	 *
	 * It used to compare the version a question was RAISED against with the
	 * version on screen, and that proxy has two holes — both reachable, both
	 * silent, and neither visible from inside the slice that introduced it:
	 *
	 * - **Amending.** `reconcileTopicQuestions` skips RESOLVED roots, so a
	 *   question answered against v1 keeps `analysisVersion: 1` forever. Amend
	 *   its answer after a regeneration to v2 and the versions differ, so the
	 *   banner stays quiet while the analysis is genuinely behind the decision
	 *   that just changed.
	 * - **Answering a soft-closed root.** The `POSSIBLY_RESOLVED` sweep sets
	 *   status only and never `analysisVersion`, so answering one after a
	 *   regeneration is silent for the same reason.
	 *
	 * A timestamp has neither hole, because every answer — first or amended —
	 * appends a reply and every reply is stamped.
	 *
	 * This is the Feature Maturation banner ("N new decisions recorded — not
	 * yet in the Full Specification") in the place that reads the same way here.
	 * The action is the Regenerate button already in this header, so the banner
	 * points at it rather than adding a second control that does the same thing.
	 */
	const analysisWrittenAt =
		aiCreatedAt === null ? null : new Date(aiCreatedAt).getTime();
	const answersNotYetFolded =
		analysisWrittenAt === null || Number.isNaN(analysisWrittenAt)
			? 0
			: (decisionThreads ?? []).filter((t) => {
					if (t.root.kind !== "QUESTION") {
						return false;
					}
					// The LIVE answer, not the first: amending appends a
					// superseding reply, and the whole point of this predicate
					// is to notice the amendment.
					const answer = liveAnswerReply(t);
					if (!answer) {
						return false;
					}
					const answeredAt = new Date(answer.createdAt).getTime();
					return (
						!Number.isNaN(answeredAt) &&
						answeredAt > analysisWrittenAt
					);
				}).length;

	return (
		<div className="space-y-5">
			{/* Version state and the two controls that change it sit together,
			    above the fold. They used to be split: Generate pinned here and
			    the provenance line plus History in a footer BELOW the document
			    and below the data sections, which on a real analysis is a long
			    scroll away from the button whose result it describes.
			    Provenance takes its own line rather than sharing the header
			    row — it runs to ~140 characters with a model name and a prompt
			    note, and would wrap badly against the buttons. */}
			{answersNotYetFolded > 0 ? (
				<div
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2 text-foreground text-sm"
					data-testid="analysis-behind-decisions"
				>
					<p>
						{answersNotYetFolded === 1
							? "1 answer was recorded after this analysis was written"
							: `${answersNotYetFolded} answers were recorded after this analysis was written`}
						{canEdit ? "." : " and are not reflected in it yet."}
					</p>
					{/* The action lives IN the banner, the way Feature
					    Maturation's does. It used to be words only — "regenerate
					    to fold them in" — pointing at a button in the header
					    strip above, which on a long analysis is a scroll away
					    from the sentence describing why to press it.

					    Same handler and same disabled rule as that button, not
					    a second path: two controls that start the same run must
					    not be able to disagree about whether one is already
					    running. */}
					{canEdit ? (
						<Button
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
							Regenerate analysis
						</Button>
					) : null}
				</div>
			) : null}

			<div className="space-y-2">
				{/* No `PLANNING & ANALYSIS` label here: the tab immediately
				    above already says it, and printing it twice was the first
				    thing a reader noticed. `justify-end` rather than
				    `justify-between` — with the label gone, `between` would
				    have pushed the controls to the left edge, under the tab
				    strip, instead of leaving them where they are. */}
				<div className="flex flex-wrap items-center justify-end gap-3">
					<div className="flex flex-wrap items-center gap-2">
						{/* Reading history is gated on read access, not edit
						    access, so it shows for a viewer too — but only
						    once there is an analysis to have a history of. */}
						{effective !== null ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setHistoryOpen(true)}
							>
								<HistoryIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
								History
							</Button>
						) : null}
						{canEdit ? (
							<Button
								variant={
									aiVersion !== null ? "outline" : "primary"
								}
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
									: aiVersion !== null
										? "Regenerate planning analysis"
										: "Generate planning analysis"}
							</Button>
						) : null}
					</div>
				</div>

				{effective !== null ? (
					<DocumentProvenance
						revisionVersion={revisionVersion}
						aiVersion={aiVersion}
						author={author}
						revisionCreatedAt={revisionCreatedAt}
						aiModel={aiModel}
						aiPromptSource={aiPromptSource}
					/>
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

			{isStale ? (
				<div className="space-y-3">
					{/* The live region is the SENTENCE, not the box around it:
					    putting the two controls inside one would have a screen
					    reader re-announce them every time the banner
					    appeared. */}
					<Banner tone="warning">
						A newer planning analysis is available (version{" "}
						{aiVersion}). This document was written from version{" "}
						{sourceAnalysisVersion}, so it does not reflect what the
						latest run found.
					</Banner>
					{newerProse !== null ? (
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setNewerOpen(true)}
							>
								View the newer analysis
							</Button>
							{canEdit ? (
								<Button
									type="button"
									variant="primary"
									size="sm"
									onClick={onReplace}
									disabled={replace.isPending}
								>
									{replace.isPending ? (
										<Loader2Icon
											className="mr-2 size-4 motion-safe:animate-spin"
											aria-hidden="true"
										/>
									) : null}
									Replace with the newer analysis
								</Button>
							) : null}
						</div>
					) : (
						<p className="text-muted-foreground text-xs">
							You can view or take it once the run in flight
							finishes.
						</p>
					)}
				</div>
			) : null}

			{effective === null ? (
				<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
					No analysis yet.
					{canEdit
						? " Generate one to see the angle, key details, recommended content types and the decisions that still need an answer."
						: ""}
				</p>
			) : (
				<div className="space-y-6">
					{showingPrevious ? (
						<p className="text-muted-foreground text-xs">
							Showing the previous analysis (version {aiVersion}).
						</p>
					) : null}

					{proseIsEmpty ? (
						<EmptyProseNotice
							effective={effective}
							canEdit={canEdit}
						/>
					) : null}

					{loadedProposal !== null ? (
						<div
							data-testid="assistant-proposal-notice"
							className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight/10 p-3"
						>
							<p className="text-sm">
								The assistant's rewrite is loaded below. Nothing
								is saved until you save it.
							</p>
							<Button
								size="sm"
								variant="outline"
								onClick={discardProposal}
							>
								Discard it
							</Button>
						</div>
					) : null}

					{/* Keyed on the seed, not merely fed it: the editor seeds
					    `prose` on mount and never re-syncs, so every change of
					    seed has to remount it — and nothing else may. */}
					<PlanningAnalysisEditor
						key={seed.generation}
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						prose={loadedProposal ?? effective.prose}
						revisionVersion={revisionVersion}
						sourceAnalysisVersion={sourceAnalysisVersion}
						canEdit={canEdit}
						onSaved={handleSaved}
					/>

					{data ? <AnalysisDataSections doc={data} /> : null}
				</div>
			)}

			<AnalysisVersionHistory
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				projectId={projectId}
				topicId={topicId}
				organizationId={organizationId}
				currentVersion={revisionVersion}
				onRestore={refreshAnalysis}
			/>

			<Dialog open={newerOpen} onOpenChange={setNewerOpen}>
				<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
					<DialogHeader>
						<DialogTitle>
							Planning analysis version {aiVersion}
						</DialogTitle>
						<DialogDescription>
							What the latest run wrote. Your own text is
							untouched until you replace it.
						</DialogDescription>
					</DialogHeader>

					<div className="prose prose-sm max-w-none dark:prose-invert">
						<Markdown>{newerProse ?? ""}</Markdown>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setNewerOpen(false)}
						>
							Close
						</Button>
						{canEdit ? (
							<Button
								type="button"
								onClick={onReplace}
								disabled={replace.isPending}
							>
								{replace.isPending ? (
									<Loader2Icon
										className="mr-2 size-4 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								) : null}
								Replace with the newer analysis
							</Button>
						) : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * A document with no words in it, said two different ways.
 *
 * "Nobody has written anything" and "somebody deliberately removed what was
 * written" are different facts, and `overridden` is the only thing that can
 * tell them apart — an author who deletes every word has made a decision, and
 * a reader who cannot see that will re-seed the document from the AI text
 * they just took out.
 */
function EmptyProseNotice({
	effective,
	canEdit,
}: {
	effective: EffectiveAnalysis;
	canEdit: boolean;
}) {
	if (effective.overridden) {
		return (
			<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
				Someone cleared this analysis. The text was removed on purpose,
				not lost —{" "}
				{canEdit
					? "write a new one below, or restore an earlier version from the history."
					: "an earlier version is still in the history."}
			</p>
		);
	}

	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{isEmptyAnalysis(effective)
				? "This analysis came back empty. The topic's sources may not carry enough to plan from yet."
				: "This analysis produced no written summary — only the structured recommendations below."}
		</p>
	);
}

const BANNER_TONES = {
	info: "flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3 text-muted-foreground text-sm",
	warning:
		"flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/5 p-3 text-foreground text-sm",
	error: "flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm",
} as const;

function Banner({
	tone,
	children,
}: {
	tone: keyof typeof BANNER_TONES;
	children: React.ReactNode;
}) {
	return (
		<p
			className={BANNER_TONES[tone]}
			// Only an error interrupts. A run that is merely in flight, or an
			// analysis that has moved on without the document, is news the
			// reader gets to when they get to it.
			role={tone === "error" ? "alert" : "status"}
		>
			{tone === "info" ? (
				<Loader2Icon
					className="mt-0.5 size-4 shrink-0 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			) : (
				<AlertTriangleIcon
					className="mt-0.5 size-4 shrink-0"
					aria-hidden="true"
				/>
			)}
			<span>{children}</span>
		</p>
	);
}

/**
 * The half the product reads by NAME, unchanged: the content-type and
 * supporting-asset buckets and the source signals. These are not part of the
 * editable document — `contentTypes` decides which media tabs are offered and
 * `sourceSignals` is provenance, so an author editing prose cannot silently
 * rewrite either.
 */
function AnalysisDataSections({
	doc,
}: {
	doc: ReturnType<typeof readPlanningAnalysis>;
}) {
	if (doc.buckets.length === 0 && doc.sourceSignals.length === 0) {
		return null;
	}

	return (
		<div className="space-y-6">
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

			{doc.sourceSignals.length > 0 ? (
				<Section label="Source signals">
					<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm leading-relaxed">
						{doc.sourceSignals.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</Section>
			) : null}
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

/**
 * Who wrote what is on screen.
 *
 * The prompt note is the load-bearing part of the provenance: an analysis
 * built from the default body because a bound prompt would not render reads
 * exactly like one built from the bound prompt, so it is the one fact about a
 * run a reader cannot recover from the output itself. It describes the READY
 * analysis on screen, and arrives as two scalars for that reason — a line that
 * read it off the newest ATTEMPT would go blank the moment a regeneration
 * failed, and FAILED is terminal: the note would be gone until someone
 * retried, on precisely the analysis a reader has most reason to question.
 *
 * Rendered in the header beside Generate/Regenerate and History rather than in
 * a footer under the document: it is a statement about what those two buttons
 * did and will do, and under a full analysis plus its data sections it sat far
 * below the fold, describing a button the reader could no longer see.
 */
function DocumentProvenance({
	revisionVersion,
	aiVersion,
	author,
	revisionCreatedAt,
	aiModel,
	aiPromptSource,
}: {
	revisionVersion: number | null;
	aiVersion: number | null;
	author: { id: string; name: string } | null;
	revisionCreatedAt: string | Date | null;
	aiModel: string | null;
	aiPromptSource: string | null;
}) {
	const usedDefault =
		aiPromptSource === "DEFAULT_UNBOUND" ||
		aiPromptSource === "DEFAULT_RENDER_FAILED";

	return (
		<p className="text-muted-foreground text-xs">
			{revisionVersion === null
				? `Not edited yet — showing analysis version ${aiVersion ?? "—"}`
				: `Version ${revisionVersion} · edited by ${author?.name?.trim() || UNKNOWN_AUTHOR_LABEL}${
						revisionCreatedAt
							? ` · ${formatWhen(revisionCreatedAt)}`
							: ""
					}`}
			{aiModel ? ` · ${aiModel}` : ""}
			{usedDefault
				? aiPromptSource === "DEFAULT_RENDER_FAILED"
					? " · built from the default prompt (the bound prompt did not render)"
					: " · built from the default prompt"
				: ""}
		</p>
	);
}

function formatWhen(value: string | Date): string {
	return new Intl.DateTimeFormat("en-US", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}
