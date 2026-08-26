"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AwaitingMeeting,
	DigestMeeting,
	DigestSeriesEntry,
} from "../lib/types";
import { LINKED_MEETINGS_QUERY_KEY } from "./use-linked-meeting-join-urls";

export interface ConfigMeeting {
	linkedMeetingId: string;
	subject: string | null;
	includedInDigest: boolean;
	lastMeetingDate: Date | string | null;
}

export function useMeetingDigest({
	projectId,
	organizationId,
	monthDate,
}: {
	projectId: string;
	organizationId: string | null;
	monthDate: Date;
}) {
	const queryClient = useQueryClient();
	// Month-window the digest fetch — without from/to every load (and every
	// toggle-invalidation) re-fetches ALL-TIME insights, which only grows more
	// expensive as history accumulates. The month key drives both the cache
	// key (so switching months doesn't show stale data mid-fetch) and the
	// refetch after mutations below.
	const monthKey = format(monthDate, "yyyy-MM");
	const from = useMemo(() => startOfMonth(monthDate), [monthDate]);
	const to = useMemo(() => endOfMonth(monthDate), [monthDate]);
	const queryKey = [
		"projects.meetingDigest.listDigest",
		projectId,
		organizationId,
		monthKey,
	];
	const configurableQueryKey = [
		"projects.meetingDigest.listConfigurable",
		projectId,
		organizationId,
	];

	const { data, isLoading, isError } = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.projects.meetingDigest.listDigest({
				projectId,
				organizationId,
				from,
				to,
			}),
	});

	const { data: configurableData } = useQuery({
		queryKey: configurableQueryKey,
		queryFn: () =>
			orpcClient.projects.meetingDigest.listConfigurable({
				projectId,
				organizationId,
			}),
	});

	const setIncluded = useCallback(
		async (linkedMeetingId: string, included: boolean) => {
			await orpcClient.projects.meetingDigest.setIncluded({
				projectId,
				organizationId,
				linkedMeetingId,
				included,
			});
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: [
						"projects.meetingDigest.listDigest",
						projectId,
						organizationId,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: [
						"projects.meetingDigest.listConfigurable",
						projectId,
						organizationId,
					],
				}),
			]);
		},
		[projectId, organizationId, queryClient],
	);

	// Link and unlink both mutate ProjectLinkedMeeting rows that four caches
	// read: the digest month page, the configurable list, and the Settings
	// screen's linked-meetings AND transcripts queries. Unlink additionally
	// cascades away ProjectMeetingTranscript rows, so the Settings
	// transcript list must be invalidated too or it can keep showing rows
	// for a meeting that no longer exists. All four are invalidated so the
	// two surfaces cannot disagree about what is linked (#1898, FR7).
	const invalidateLinkCaches = useCallback(
		() =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: [
						"projects.meetingDigest.listDigest",
						projectId,
						organizationId,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: [
						"projects.meetingDigest.listConfigurable",
						projectId,
						organizationId,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: [
						LINKED_MEETINGS_QUERY_KEY,
						projectId,
						organizationId,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: [
						"meeting-transcript-sync-transcripts",
						projectId,
						organizationId,
					],
				}),
			]).then(() => undefined),
		[queryClient, projectId, organizationId],
	);

	// Unlink is destructive beyond the digest: the procedure deletes the
	// ProjectLinkedMeeting row AND fires a Temporal contextDeletionWorkflow
	// that purges the meeting's transcript context from Qdrant. Callers must
	// gate this behind a confirmation (#1898, FR6).
	const unlinkMeeting = useCallback(
		async (linkedMeetingId: string) => {
			await orpcClient.projects.meetingTranscriptSync.unlinkMeeting({
				projectId,
				organizationId,
				linkedMeetingId,
			});
			await invalidateLinkCaches();
		},
		[projectId, organizationId, invalidateLinkCaches],
	);

	const refreshAfterLink = invalidateLinkCaches;

	// Cross-surface toggle refresh: the agenda and the detail sheet each cache
	// their own action-item state (listDigest's month page vs getMeeting's
	// per-transcript entry). Toggling in either place must invalidate BOTH so
	// the other surface doesn't keep showing a stale checkbox state.
	const onActionItemToggled = useCallback(
		() =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: [
						"projects.meetingDigest.listDigest",
						projectId,
						organizationId,
						monthKey,
					],
				}),
				queryClient.invalidateQueries({
					queryKey: ["projects.meetingDigest.getMeeting", projectId],
				}),
			]),
		[queryClient, projectId, organizationId, monthKey],
	);

	const [generatingRefs, setGeneratingRefs] = useState<Set<string>>(
		new Set(),
	);
	// FR6 (#1823): per-meeting failure surface for the inline generate flow.
	// Keyed by transcriptRef; a ref is never in both generatingRefs and here.
	const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(
		new Map(),
	);

	// FR3 (#1823): fire-and-forget insight extraction triggered from the
	// agenda's inline "Generate summary" button. `transcriptId` is the Graph
	// id extractInsights expects; `transcriptRef` is the row cuid that
	// DigestMeeting rows (and generatingRefs) key on — keep these distinct,
	// they are not interchangeable.
	const isMountedRef = useRef(true);
	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const generateSummary = useCallback(
		(transcriptId: string, transcriptRef: string) => {
			setGeneratingRefs((s) => new Set(s).add(transcriptRef));
			setSummaryErrors((m) => {
				if (!m.has(transcriptRef)) {
					return m;
				}
				const next = new Map(m);
				next.delete(transcriptRef);
				return next;
			});
			// Reset the shared poll budget whenever a new generation joins the
			// set: the cap bounds the LAST-started generation's ~90s window, not
			// whichever one happened to start the interval first — otherwise a
			// generation kicked off late in another's polling window would
			// inherit a near-exhausted budget and get cut short prematurely.
			pollCountRef.current = 0;
			orpcClient.projects.meetingDigest
				.extractInsights({ projectId, organizationId, transcriptId })
				.then((res) => {
					// force is never set here, but the text-source guard still
					// applies: a transcript row with no context body and no stored
					// summary reports { started: false, reason: "not-needed" }.
					// Nothing will ever land, so stop now instead of burning the
					// full poll budget on a spinner (mirrors the sheet's
					// regenerate handling).
					if (res.started || res.reason !== "not-needed") {
						return;
					}
					if (!isMountedRef.current) {
						return;
					}
					setGeneratingRefs((s) => {
						const next = new Set(s);
						next.delete(transcriptRef);
						return next;
					});
					setSummaryErrors((m) =>
						new Map(m).set(
							transcriptRef,
							"Nothing to summarize — this meeting has no transcript content.",
						),
					);
				})
				.catch((error) => {
					console.error(
						"meeting-digest: inline extractInsights failed",
						{
							transcriptId,
							error,
						},
					);
					if (!isMountedRef.current) {
						return;
					}
					setGeneratingRefs((s) => {
						const next = new Set(s);
						next.delete(transcriptRef);
						return next;
					});
					setSummaryErrors((m) =>
						new Map(m).set(
							transcriptRef,
							"Summary generation failed — try again.",
						),
					);
				});
		},
		[projectId, organizationId],
	);

	// Bounded poll while anything is generating: refetch the month query every
	// 4s (sheet cadence), stop when insights land or after 22 ticks.
	const pollCountRef = useRef(0);
	useEffect(() => {
		if (generatingRefs.size === 0) {
			pollCountRef.current = 0;
			return;
		}
		const interval = setInterval(() => {
			pollCountRef.current += 1;
			if (pollCountRef.current > 22) {
				// Budget exhausted: don't silently revert to the idle button —
				// mark every in-flight ref stalled so AgendaView can say the
				// generation didn't land (FR6), matching the sheet's
				// extractionStalled treatment.
				console.error(
					"meeting-digest: inline summary poll budget exhausted",
					{ transcriptRefs: [...generatingRefs] },
				);
				setSummaryErrors((m) => {
					const next = new Map(m);
					for (const ref of generatingRefs) {
						next.set(
							ref,
							"Summary generation didn't finish. It may have failed or timed out.",
						);
					}
					return next;
				});
				setGeneratingRefs(new Set());
				return;
			}
			queryClient.invalidateQueries({
				queryKey: [
					"projects.meetingDigest.listDigest",
					projectId,
					organizationId,
					monthKey,
				],
			});
		}, 4000);
		return () => clearInterval(interval);
	}, [generatingRefs, queryClient, projectId, organizationId, monthKey]);

	// Month navigation resets the generating UX: the extraction keeps running
	// server-side (and extractInsights dedupes concurrent starts), but polling
	// a different month's query can never observe the origin row's readiness,
	// so we don't pretend to track it across months.
	useEffect(() => {
		setGeneratingRefs(new Set());
		setSummaryErrors(new Map());
		pollCountRef.current = 0;
	}, [monthKey]);

	// Clear refs whose insights have landed — including stalled errors, so a
	// generation that completes server-side after the poll budget ran out
	// stops claiming it failed once the fresh data arrives.
	useEffect(() => {
		if (
			(generatingRefs.size === 0 && summaryErrors.size === 0) ||
			!data?.meetings
		) {
			return;
		}
		const ready = new Set(
			(data.meetings as DigestMeeting[])
				.filter((m) => m.insightsReady)
				.map((m) => m.transcriptRef),
		);
		if ([...generatingRefs].some((r) => ready.has(r))) {
			setGeneratingRefs(
				(s) => new Set([...s].filter((r) => !ready.has(r))),
			);
		}
		if ([...summaryErrors.keys()].some((r) => ready.has(r))) {
			setSummaryErrors(
				(m) => new Map([...m].filter(([r]) => !ready.has(r))),
			);
		}
	}, [data, generatingRefs, summaryErrors]);

	return {
		meetings: (data?.meetings ?? []) as DigestMeeting[],
		seriesWithoutTranscripts: (data?.seriesWithoutTranscripts ??
			[]) as DigestSeriesEntry[],
		// #2051 — included linked occurrences that happened but whose transcript
		// has not synced. Dated from ProjectMeetingAgenda, so they can sit on the
		// calendar grid rather than only in the advisory band.
		awaitingOccurrences: (data?.awaitingOccurrences ??
			[]) as AwaitingMeeting[],
		configMeetings: (configurableData?.meetings ?? []) as ConfigMeeting[],
		isLoading,
		isError,
		setIncluded,
		unlinkMeeting,
		refreshAfterLink,
		onActionItemToggled,
		generateSummary,
		generatingRefs,
		summaryErrors,
	};
}
