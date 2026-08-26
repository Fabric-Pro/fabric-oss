"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Poll budget: 22 ticks at 4s ≈ 90 seconds. Matches the meeting-insights budget
 * in use-meeting-digest.ts. A generation that outlives it is reported as stalled
 * — the UI must never poll forever on a row no workflow will complete.
 */
export const MAX_AGENDA_POLLS = 22;
const POLL_INTERVAL_MS = 4000;

/**
 * `getAgenda`'s true return shape, inferred straight from the oRPC client
 * rather than hand-written — this is exactly what TanStack Query caches
 * under `queryKey`, so it's what `setQueryData` updaters must be typed
 * against. Notably `contextStats` here is Prisma's `Json` (`JsonValue |
 * null`): the DB column (`ProjectMeetingAgenda.contextStats`) is schemaless,
 * so the server genuinely cannot promise more than that.
 */
type GetAgendaResult = Awaited<
	ReturnType<typeof orpcClient.projects.meetingDigest.getAgenda>
>;
type ServerAgenda = NonNullable<GetAgendaResult["agenda"]>;
type AgendaQueryData = { agenda: ServerAgenda | null };

/** The shape of `contextStats` that the UI actually reads (FR5's "no prior
 * transcripts" notice and the per-field truncation warning). */
export interface AgendaContextStats {
	hadPriorTranscripts?: boolean;
	truncated?: Record<string, boolean>;
	/**
	 * Provenance counts behind the "How this agenda was built" expander (#2105).
	 * All optional: every agenda generated before #2105 has a `contextStats` blob
	 * without them, and the expander must simply not render for those rather than
	 * reporting zeroes it never measured.
	 */
	priorTranscriptCount?: number;
	carriedActionItemCount?: number;
	priorMeetingWindowDays?: number;
	openActionItemCount?: number;
	openDecisionCount?: number;
	blockedStoryCount?: number;
}

/** The count/config keys narrowed above — kept beside the interface so the two cannot drift. */
const NUMERIC_STAT_KEYS = [
	"priorTranscriptCount",
	"carriedActionItemCount",
	"priorMeetingWindowDays",
	"openActionItemCount",
	"openDecisionCount",
	"blockedStoryCount",
] as const satisfies ReadonlyArray<keyof AgendaContextStats>;

/**
 * Which prompt produced an agenda. Written by `generateAgendaActivity`; every
 * field is optional because agendas generated before the prompt became editable
 * carry no provenance at all, and reporting "built from the default prompt" for
 * one of those would be a claim we never measured.
 */
export interface AgendaPromptProvenance {
	/**
	 * BOUND — a prompt from the library produced this agenda.
	 * DEFAULT_UNBOUND — nothing was bound, the built-in prompt was used.
	 * DEFAULT_RENDER_FAILED — a prompt was bound but could not render, so the
	 * built-in prompt was used instead. Indistinguishable from BOUND in the
	 * output, which is the whole reason this is recorded.
	 */
	source?: "BOUND" | "DEFAULT_UNBOUND" | "DEFAULT_RENDER_FAILED";
	promptId?: string;
	promptName?: string;
	promptScope?: string;
	promptVersion?: number;
	/** The bound prompt's format does no templating and was read as Handlebars. */
	formatOverridden?: boolean;
}

/**
 * View type used once data has left the cache boundary. Identical to
 * `ServerAgenda` except `contextStats` and `promptProvenance` are narrowed from
 * `Json` to the shapes the UI relies on — see `toAgendaRecord`, the one place
 * that narrowing happens.
 */
export interface AgendaRecord
	extends Omit<ServerAgenda, "contextStats" | "promptProvenance"> {
	contextStats: AgendaContextStats | null;
	promptProvenance: AgendaPromptProvenance | null;
}

/**
 * Narrows `contextStats` from Prisma `Json` down to the shape AgendaSheet
 * reads (`hadPriorTranscripts`, `truncated`), dropping anything that isn't
 * shaped as expected rather than trusting the DB blob structurally. This is
 * the only place the Json→view narrowing happens, so `setQueryData` cache
 * boundaries can stay honestly typed against the server's `Json` field.
 */
function narrowContextStats(value: unknown): AgendaContextStats | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const result: AgendaContextStats = {};
	if (typeof record.hadPriorTranscripts === "boolean") {
		result.hadPriorTranscripts = record.hadPriorTranscripts;
	}
	if (
		typeof record.truncated === "object" &&
		record.truncated !== null &&
		!Array.isArray(record.truncated)
	) {
		const truncated: Record<string, boolean> = {};
		for (const [key, flag] of Object.entries(
			record.truncated as Record<string, unknown>,
		)) {
			if (typeof flag === "boolean") {
				truncated[key] = flag;
			}
		}
		result.truncated = truncated;
	}
	// Finite check, not just typeof: JSON.parse happily yields NaN/Infinity via
	// some producers, and "NaN prior meetings" is worse than no expander at all.
	for (const key of NUMERIC_STAT_KEYS) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Narrows `promptProvenance` the same way `narrowContextStats` does: field by
 * field, dropping anything not shaped as expected rather than trusting the DB
 * blob structurally. An unrecognised `source` is dropped rather than rendered,
 * so an older or newer writer can never put an unexplained token on screen.
 */
function narrowPromptProvenance(value: unknown): AgendaPromptProvenance | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const result: AgendaPromptProvenance = {};
	if (
		record.source === "BOUND" ||
		record.source === "DEFAULT_UNBOUND" ||
		record.source === "DEFAULT_RENDER_FAILED"
	) {
		result.source = record.source;
	}
	for (const key of ["promptId", "promptName", "promptScope"] as const) {
		const field = record[key];
		if (typeof field === "string" && field.length > 0) {
			result[key] = field;
		}
	}
	if (
		typeof record.promptVersion === "number" &&
		Number.isFinite(record.promptVersion)
	) {
		result.promptVersion = record.promptVersion;
	}
	if (typeof record.formatOverridden === "boolean") {
		result.formatOverridden = record.formatOverridden;
	}
	return result;
}

function toAgendaRecord(agenda: ServerAgenda): AgendaRecord;
function toAgendaRecord(
	agenda: ServerAgenda | null | undefined,
): AgendaRecord | null;
function toAgendaRecord(
	agenda: ServerAgenda | null | undefined,
): AgendaRecord | null {
	if (!agenda) {
		return null;
	}
	return {
		...agenda,
		contextStats: narrowContextStats(agenda.contextStats),
		promptProvenance: narrowPromptProvenance(agenda.promptProvenance),
	};
}

export function useMeetingAgenda({
	projectId,
	organizationId,
	linkedMeetingId,
	occurrenceStart,
}: {
	projectId: string;
	organizationId?: string | null;
	linkedMeetingId: string;
	occurrenceStart: string;
}) {
	const queryClient = useQueryClient();
	const pollCount = useRef(0);
	const [stalled, setStalled] = useState(false);
	// Set when saveAgenda comes back with `{ saved: false, reason: "conflict" }`
	// — another admin saved first. Holds *their* version so the UI can offer a
	// deliberate choice instead of silently refetching over the user's draft
	// (the #1987 data-loss shape).
	const [conflict, setConflict] = useState<AgendaRecord | null>(null);

	const input = {
		projectId,
		organizationId,
		linkedMeetingId,
		occurrenceStart,
	};

	const queryKey = orpc.projects.meetingDigest.getAgenda.queryKey({ input });

	const query = useQuery(
		orpc.projects.meetingDigest.getAgenda.queryOptions({
			input,
			// TanStack pauses interval refetches for hidden tabs by default,
			// and a generation takes long enough that users tab away while
			// they wait. With the default, nobody observes GENERATING→READY:
			// the sheet stays on "Drafting…" and the listUpcoming
			// invalidation below never fires, freezing the row indicator
			// until a reload (#2136). The poll budget above already bounds
			// the cost, visible or not.
			refetchIntervalInBackground: true,
			refetchInterval: (q) => {
				const status = q.state.data?.agenda?.status;
				if (status !== "GENERATING") {
					pollCount.current = 0;
					return false;
				}
				if (pollCount.current >= MAX_AGENDA_POLLS) {
					setStalled(true);
					return false;
				}
				pollCount.current += 1;
				return POLL_INTERVAL_MS;
			},
		}),
	);

	const agenda = toAgendaRecord(query.data?.agenda);

	// The digest's row indicator (#2106) is filled by listUpcoming, which does
	// not poll — so a row goes on reading "Agenda generating" after the workflow
	// finishes, which is exactly what the user sees on closing this sheet.
	//
	// This hook is already polling for that transition, so the completion moment
	// is known here for free. Invalidate the list ONCE, when the status leaves
	// GENERATING, rather than polling listUpcoming: that procedure calls
	// Microsoft Graph (600-2600ms observed on staging), so polling it every few
	// seconds during a generation would add ~15 Graph round trips per run — the
	// opposite of what #2106 set out to do.
	//
	// The partial `key()` is deliberate: listUpcoming is cached under two chunk
	// inputs, and an exact queryKey() would refresh only the chunk this meeting
	// happens to sit in.
	const previousStatus = useRef<string | null>(null);
	useEffect(() => {
		const status = agenda?.status ?? null;
		if (
			previousStatus.current === "GENERATING" &&
			status !== null &&
			status !== "GENERATING"
		) {
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.meetingDigest.listUpcoming.key(),
			});
		}
		previousStatus.current = status;
	}, [agenda?.status, queryClient]);

	// Tracks the generateAgenda round trip independent of the row's own
	// GENERATING status — the row doesn't flip to GENERATING until the
	// request lands, and (FIX 5) a double-click before that first response
	// arrives must still be blocked, not just once polling has started.
	const [isGeneratePending, setIsGeneratePending] = useState(false);

	const generate = useCallback(
		async (force = false) => {
			pollCount.current = 0;
			setStalled(false);
			setIsGeneratePending(true);
			try {
				const result =
					await orpcClient.projects.meetingDigest.generateAgenda({
						...input,
						force,
					});

				if (result.reason === "would-discard-edits") {
					return "would-discard-edits" as const;
				}

				if (result.reason === "in-progress") {
					// A run is already going for this occurrence — not an error,
					// but silently dropping it (as before) leaves an admin who
					// double-clicked with zero feedback that anything happened.
					toast.info("Generation is already in progress", {
						description:
							"The agenda will update automatically once it's ready.",
					});
					return result.reason;
				}

				await Promise.all([
					queryClient.invalidateQueries({
						queryKey:
							orpc.projects.meetingDigest.getAgenda.queryKey({
								input,
							}),
					}),
					// The digest's upcoming list carries a per-meeting agenda
					// indicator (#2106). It is fetched as two day-chunks with
					// different inputs, so invalidate on the PARTIAL key —
					// `key()`, not `queryKey()` — or the chunk this meeting
					// happens to sit in goes unrefreshed and the row keeps
					// reading "No agenda yet" behind the sheet that just started
					// generating it.
					queryClient.invalidateQueries({
						queryKey:
							orpc.projects.meetingDigest.listUpcoming.key(),
					}),
				]);
				return result.reason;
			} catch (error) {
				// generateAgenda throws BAD_REQUEST/FORBIDDEN/NOT_FOUND for the
				// flag-off case, "link this meeting first", the past-meeting
				// rejection, and any workflow-start rollback. This was called
				// unawaited-of-errors from an onClick with no try/catch, so every
				// one of those produced an unhandled rejection and zero user
				// feedback — the shared oRPC interceptor suppresses those status
				// codes entirely (#1901 final review, FIX 2).
				toast.error("Couldn't generate the agenda", {
					description:
						error instanceof Error
							? error.message
							: "Please try again.",
				});
				return "error" as const;
			} finally {
				setIsGeneratePending(false);
			}
		},
		[
			projectId,
			organizationId,
			linkedMeetingId,
			occurrenceStart,
			queryClient,
		],
	);

	const saveMutation = useMutation({
		mutationFn: async (content: string) => {
			if (!agenda) {
				throw new Error("No agenda to save");
			}
			return orpcClient.projects.meetingDigest.saveAgenda({
				projectId,
				organizationId,
				agendaId: agenda.id,
				content,
				expectedVersion: agenda.version,
			});
		},
		onSuccess: async (result) => {
			if (!result.saved) {
				// Someone else saved first. Do NOT invalidate/refetch here — that
				// would pull the other admin's content over the user's in-progress
				// draft before they can react (the #1987 data-loss shape). Surface
				// their version instead and let the user choose deliberately via
				// keepMine()/takeIncoming().
				setConflict(toAgendaRecord(result.current));
				toast.warning("Someone else edited this agenda", {
					description:
						"Review both versions below and choose which to keep.",
				});
				return;
			}
			setConflict(null);
			await queryClient.invalidateQueries({ queryKey });
		},
		onError: () => {
			toast.error("Couldn't save the agenda", {
				description:
					"Your changes are still in the editor. Please try again.",
			});
		},
	});

	// User chose to keep their own draft after a conflict. We can't silently
	// resolve the conflict — just adopt the version number the other admin
	// left behind so the *next* save targets the row as it now exists instead
	// of bouncing off the same conflict forever. Content is left untouched;
	// the draft itself lives in AgendaBody and was never overwritten.
	const keepMine = useCallback(() => {
		if (!conflict) {
			return;
		}
		const incomingVersion = conflict.version;
		queryClient.setQueryData(
			queryKey,
			(old: AgendaQueryData | undefined) =>
				old?.agenda
					? {
							...old,
							agenda: { ...old.agenda, version: incomingVersion },
						}
					: old,
		);
		setConflict(null);
	}, [conflict, queryClient, queryKey]);

	// User chose to discard their draft and load the other admin's version
	// instead. This is the one path allowed to replace the draft's content —
	// it is an explicit choice, not an automatic refetch.
	const takeIncoming = useCallback(() => {
		if (!conflict) {
			return;
		}
		queryClient.setQueryData(
			queryKey,
			(old: AgendaQueryData | undefined) => ({
				...(old ?? {}),
				agenda: {
					...conflict,
					// `conflict` is the narrowed view type (see toAgendaRecord) —
					// its `contextStats` and `promptProvenance` were already
					// parsed out of these same Json blobs, so these casts just
					// return them to the server's wire shape at the one point a
					// view value re-enters the cache.
					contextStats:
						conflict.contextStats as unknown as ServerAgenda["contextStats"],
					promptProvenance:
						conflict.promptProvenance as unknown as ServerAgenda["promptProvenance"],
				},
			}),
		);
		setConflict(null);
	}, [conflict, queryClient, queryKey]);

	return {
		agenda,
		isLoading: query.isLoading,
		isGenerating: agenda?.status === "GENERATING",
		isGeneratePending,
		stalled,
		generate,
		save: saveMutation.mutateAsync,
		isSaving: saveMutation.isPending,
		conflict,
		keepMine,
		takeIncoming,
	};
}
