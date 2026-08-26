"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { useEffect, useRef, useState } from "react";
import type {
	AgendaContextStats,
	AgendaPromptProvenance,
	AgendaRecord,
} from "../hooks/use-meeting-agenda";
import { useMeetingAgenda } from "../hooks/use-meeting-agenda";

const plural = (count: number, noun: string) =>
	`${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * "How this agenda was built" (#2105 — UC1 step 4).
 *
 * Reads the `contextStats` blob the generation activity already persists, so
 * this needs no new procedure — which is also the safe choice: a new procedure
 * in @repo/api is not on the input-org-unverified ratchet baseline and would
 * fail CI.
 *
 * Collapsed by default and advisory in tone: it explains what the agenda was
 * built from, and never suggests the user act on it.
 */
/**
 * One line naming the prompt that shaped the agenda.
 *
 * Returns null for agendas generated before provenance was recorded — saying
 * "built from the built-in prompt" for one of those would be a measurement we
 * never took. The DEFAULT_RENDER_FAILED wording is the load-bearing case: that
 * agenda reads exactly like a healthy one, so this line is the only place the
 * author of a broken prompt learns it never ran.
 */
function promptProvenanceLine(
	provenance: AgendaPromptProvenance | null,
): string | null {
	if (!provenance?.source) {
		return null;
	}

	const named = provenance.promptName
		? provenance.promptVersion !== undefined
			? `${provenance.promptName} (v${provenance.promptVersion})`
			: provenance.promptName
		: null;

	if (provenance.source === "DEFAULT_UNBOUND") {
		return "Written with the built-in prompt — no prompt is bound to agenda generation";
	}

	if (provenance.source === "DEFAULT_RENDER_FAILED") {
		return named
			? `${named} could not be rendered, so the built-in prompt was used instead`
			: "The bound prompt could not be rendered, so the built-in prompt was used instead";
	}

	const base = named
		? `Written with ${named}`
		: "Written with a bound prompt";
	return provenance.formatOverridden
		? `${base} — its format does no templating, so it was read as Handlebars`
		: base;
}

function AgendaMethodology({
	stats,
	provenance,
}: {
	stats: AgendaContextStats | null;
	provenance: AgendaPromptProvenance | null;
}) {
	// Gate on the counts, not on `stats` being present: every agenda generated
	// before #2105 has a contextStats blob that predates these fields, and
	// reporting "0 prior meetings" for one would be a measurement we never took.
	if (!stats || stats.priorTranscriptCount === undefined) {
		return null;
	}

	const lines = [
		stats.priorMeetingWindowDays
			? `${plural(stats.priorTranscriptCount, "prior meeting")} in this series, from the last ${stats.priorMeetingWindowDays} days`
			: `${plural(stats.priorTranscriptCount, "prior meeting")} in this series`,
		stats.carriedActionItemCount !== undefined
			? plural(
					stats.carriedActionItemCount,
					"carried-forward action item",
				)
			: null,
		stats.openActionItemCount !== undefined
			? plural(stats.openActionItemCount, "other open action item")
			: null,
		stats.openDecisionCount !== undefined
			? plural(stats.openDecisionCount, "unresolved question")
			: null,
		stats.blockedStoryCount !== undefined
			? plural(stats.blockedStoryCount, "blocked item")
			: null,
	].filter((line): line is string => line !== null);

	const provenanceLine = promptProvenanceLine(provenance);

	return (
		<details className="rounded border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
			<summary className="cursor-pointer">
				How this agenda was built
			</summary>
			<ul className="mt-2 list-disc space-y-0.5 pl-5">
				{lines.map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			{provenanceLine && (
				<p className="mt-2 border-t pt-2">{provenanceLine}</p>
			)}
		</details>
	);
}

interface BodyProps {
	agenda: AgendaRecord | null;
	canEdit: boolean;
	stalled: boolean;
	isSaving?: boolean;
	onSave: (content: string) => Promise<{ saved: boolean } | undefined>;
	conflict?: AgendaRecord | null;
	onKeepMine?: () => void;
	onTakeIncoming?: () => void;
}

/**
 * Presentational body — split from the data layer so every state can be
 * rendered in tests without a query client, matching the TranscriptBody split
 * made for #1899.
 */
export function AgendaBody({
	agenda,
	canEdit,
	stalled,
	isSaving = false,
	onSave,
	conflict = null,
	onKeepMine,
	onTakeIncoming,
}: BodyProps) {
	const [draft, setDraft] = useState(agenda?.content ?? "");
	// Tracked explicitly rather than inferred from string comparison: dirty
	// means "the user has typed since the last sync/save", and it is the only
	// thing allowed to block the incoming-content sync effect below. A save
	// conflict (see `conflict`) must NOT clear this — the whole point is that
	// the user's edits survive it.
	const [dirty, setDirty] = useState(false);

	// The saved content is authoritative when it changes underneath us (a
	// regeneration completed) — but only while the draft is clean. A dirty
	// draft must never be clobbered by content arriving out from under the
	// user (e.g. the conflict path deliberately updates the cache without
	// touching this).
	const lastSyncedRef = useRef(agenda?.content ?? "");
	useEffect(() => {
		if (dirty) {
			return;
		}
		const next = agenda?.content ?? "";
		if (next !== lastSyncedRef.current) {
			lastSyncedRef.current = next;
			setDraft(next);
		}
	}, [agenda?.content, dirty]);

	const handleSave = async () => {
		const result = await onSave(draft);
		if (result?.saved) {
			lastSyncedRef.current = draft;
			setDirty(false);
		}
		// On conflict (result.saved === false), dirty stays true and the
		// draft is untouched — the conflict banner below is how the user
		// finds out and decides what happens next.
	};

	const handleKeepMine = () => {
		onKeepMine?.();
		// Draft/dirty are intentionally left as-is: the user is choosing to
		// keep typing/saving their own version.
	};

	const handleTakeIncoming = () => {
		if (conflict) {
			lastSyncedRef.current = conflict.content ?? "";
			setDraft(conflict.content ?? "");
			setDirty(false);
		}
		onTakeIncoming?.();
	};

	if (!agenda) {
		return (
			<p className="text-sm text-muted-foreground">
				No agenda yet for this meeting.
			</p>
		);
	}

	if (agenda.status === "GENERATING") {
		return stalled ? (
			<p className="rounded border border-amber-500/40 px-3 py-2 text-sm">
				This is taking longer than expected. The agenda may still arrive
				— reopen this panel in a minute, or generate again.
			</p>
		) : (
			<p className="text-sm text-muted-foreground" aria-live="polite">
				Drafting the agenda from recent meetings and open work…
			</p>
		);
	}

	if (agenda.status === "FAILED") {
		// A failed regenerate only ever touches status/generationError — the
		// prior content (including hand edits) is still sitting in the row.
		// Returning early on just the error, as before, made a good agenda
		// plus one failed regenerate into content nobody could reach anymore.
		// Render it back with a note instead (#1901 final review, FIX 4).
		return (
			<div className="space-y-3">
				<p className="rounded border border-destructive/40 px-3 py-2 text-sm text-destructive">
					Agenda generation failed:{" "}
					{agenda.generationError ?? "unknown error"}
				</p>
				{agenda.content && (
					<div className="space-y-1">
						<p className="text-xs text-muted-foreground">
							Showing the last successful version.
						</p>
						<pre className="whitespace-pre-wrap rounded border p-3 text-sm">
							{agenda.content}
						</pre>
					</div>
				)}
			</div>
		);
	}

	const truncatedAny = Object.values(
		agenda.contextStats?.truncated ?? {},
	).some(Boolean);

	return (
		<div className="space-y-3">
			{agenda.contextStats?.hadPriorTranscripts === false && (
				<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
					No prior meetings from this series
					{agenda.contextStats.priorMeetingWindowDays
						? ` in the last ${agenda.contextStats.priorMeetingWindowDays} days`
						: ""}
					. This agenda was built from open tickets and action items.
				</p>
			)}

			{truncatedAny && (
				<p className="rounded border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
					There was more open work than fits in one agenda — only the
					most recent items were used.
				</p>
			)}

			<AgendaMethodology
				stats={agenda.contextStats}
				provenance={agenda.promptProvenance}
			/>

			{canEdit ? (
				<>
					{conflict && (
						<div className="space-y-2 rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
							<p>
								Someone else saved a newer version of this
								agenda while you were editing. Your draft below
								is untouched — choose which version to keep.
							</p>
							<pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border bg-background p-2 text-xs">
								{conflict.content}
							</pre>
							<div className="flex gap-2">
								<button
									type="button"
									className="rounded border px-2 py-1 text-xs hover:bg-muted"
									onClick={handleKeepMine}
								>
									Keep my edits
								</button>
								<button
									type="button"
									className="rounded border px-2 py-1 text-xs hover:bg-muted"
									onClick={handleTakeIncoming}
								>
									Load their version
								</button>
							</div>
						</div>
					)}
					<textarea
						aria-label="Agenda content"
						className="min-h-64 w-full rounded border p-3 font-mono text-sm"
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							setDirty(true);
						}}
					/>
					<button
						type="button"
						className="rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
						disabled={isSaving || !dirty}
						onClick={() => void handleSave()}
					>
						{isSaving ? "Saving…" : "Save agenda"}
					</button>
				</>
			) : (
				<pre className="whitespace-pre-wrap rounded border p-3 text-sm">
					{agenda.content}
				</pre>
			)}
		</div>
	);
}

interface SheetProps {
	projectId: string;
	organizationId?: string | null;
	linkedMeetingId: string;
	occurrenceStart: string;
	meetingSubject: string;
	canEdit: boolean;
	onClose: () => void;
}

export function AgendaSheet({
	projectId,
	organizationId,
	linkedMeetingId,
	occurrenceStart,
	meetingSubject,
	canEdit,
	onClose,
}: SheetProps) {
	const {
		agenda,
		isGenerating,
		isGeneratePending,
		stalled,
		generate,
		save,
		isSaving,
		conflict,
		keepMine,
		takeIncoming,
	} = useMeetingAgenda({
		projectId,
		organizationId,
		linkedMeetingId,
		occurrenceStart,
	});

	// A stalled generation is, by definition, one the button must be able to
	// retry — `stalled` only becomes true once polling gives up, so gating on
	// `isGenerating` alone left the row permanently GENERATING with no escape
	// but a DB edit (#1901 final review, FIX 1). Once the request itself is
	// in flight, block a second click regardless of what the row currently
	// says (FIX 5) — the row doesn't flip to GENERATING until the request
	// lands.
	const generateDisabled = (isGenerating && !stalled) || isGeneratePending;

	const { confirm } = useConfirmationAlert();

	const handleGenerate = async () => {
		const reason = await generate(false);
		// D7 — never discard hand edits silently. The warning goes through the
		// shared ConfirmationAlert, not window.confirm: a native dialog blocks
		// the renderer thread (freezing every other interaction, including
		// automation) and sits outside the app's dialog conventions — the
		// unlink confirm two components over is a Radix modal for the same
		// reason (#2136 review note).
		if (reason === "would-discard-edits") {
			confirm({
				title: "Regenerate this agenda?",
				message:
					"This agenda has been edited. Regenerating will replace those edits.",
				confirmLabel: "Regenerate",
				destructive: true,
				onConfirm: async () => {
					await generate(true);
				},
			});
		}
	};

	return (
		<aside
			className="fixed inset-y-0 right-0 z-50 w-[480px] overflow-y-auto border-l bg-background p-4"
			aria-label={`Agenda for ${meetingSubject}`}
		>
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-base font-semibold">{meetingSubject}</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close agenda"
				>
					✕
				</button>
			</div>

			{canEdit && (
				<button
					type="button"
					className="mb-3 rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
					disabled={generateDisabled}
					onClick={handleGenerate}
				>
					{agenda ? "Regenerate agenda" : "Generate agenda"}
				</button>
			)}

			<AgendaBody
				agenda={agenda}
				canEdit={canEdit}
				stalled={stalled}
				isSaving={isSaving}
				onSave={save}
				conflict={conflict}
				onKeepMine={keepMine}
				onTakeIncoming={takeIncoming}
			/>
		</aside>
	);
}
