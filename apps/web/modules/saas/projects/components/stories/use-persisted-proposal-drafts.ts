"use client";

/**
 * Client hook for the server-persisted, team-shared in-review proposal drafts.
 *
 * Owns the poll + start/cancel for a single proposal's drafts (both kinds).
 * Backs the inbox flow: a draft is generated ONCE per (proposal, kind) on the
 * server (race-safe), so this hook just observes the shared state and exposes
 * idempotent start/cancel. `startedAt` is the server clock for the shared
 * count-up counter (identical in every tab/user once polled).
 *
 * Inert unless `enabled` + `proposalId` + `projectId` are all present (the AI
 * Update sidebar passes no proposalId and keeps its in-memory reformat path).
 */

import { useCallback, useEffect, useState } from "react";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import type { ChangeItemKind } from "./BacklogChangeProposal";

type ProposalDraftStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface ProposalDraftState {
	kind: ChangeItemKind;
	status: ProposalDraftStatus;
	/** ISO string — server clock for the shared elapsed counter. */
	startedAt: string;
	description: string | null;
	acceptanceCriteria: string | null;
	needsMoreInfo: boolean | null;
}

type ProposalDraftsByKind = Partial<Record<ChangeItemKind, ProposalDraftState>>;

interface Params {
	proposalId?: string;
	projectId?: string;
	organizationId?: string | null;
}

interface Result {
	byKind: ProposalDraftsByKind;
	/** Idempotent: claims + starts the draft server-side (no-op if running/done). */
	startDraft: (kind: ChangeItemKind) => void;
	/** Cancels an in-flight draft (and aborts the workflow server-side). */
	cancelDraft: (kind: ChangeItemKind) => Promise<void>;
	active: boolean;
}

function toState(d: {
	kind: string;
	status: string;
	startedAt: string | Date;
	description: string | null;
	acceptanceCriteria: string | null;
	needsMoreInfo: boolean | null;
}): ProposalDraftState {
	return {
		kind: d.kind as ChangeItemKind,
		status: d.status as ProposalDraftStatus,
		startedAt:
			typeof d.startedAt === "string"
				? d.startedAt
				: new Date(d.startedAt).toISOString(),
		description: d.description,
		acceptanceCriteria: d.acceptanceCriteria,
		needsMoreInfo: d.needsMoreInfo,
	};
}

export function usePersistedProposalDrafts(params: Params): Result {
	const { proposalId, projectId, organizationId } = params;
	const active = Boolean(proposalId && projectId);

	const [byKind, setByKind] = useState<ProposalDraftsByKind>({});

	const refetch = useCallback(async () => {
		if (!active || !proposalId || !projectId) {
			return;
		}
		try {
			const res = await orpcClient.projects.backlog.drafts.list({
				projectId,
				organizationId: organizationId ?? null,
				proposalId,
			});
			const next: ProposalDraftsByKind = {};
			for (const d of res.drafts) {
				next[d.kind as ChangeItemKind] = toState(d);
			}
			setByKind(next);
		} catch {
			// Transient — keep the last known state; the next tick retries.
		}
	}, [active, proposalId, projectId, organizationId]);

	// Reset + initial load when the proposal changes.
	useEffect(() => {
		setByKind({});
		if (active) {
			void refetch();
		}
	}, [active, refetch]);

	// Poll while any kind is still drafting; stop once everything is terminal.
	const anyRunning =
		byKind.BUG?.status === "RUNNING" ||
		byKind.FEATURE?.status === "RUNNING";
	useEffect(() => {
		if (!active || !anyRunning) {
			return;
		}
		const t = setInterval(() => void refetch(), 3000);
		return () => clearInterval(t);
	}, [active, anyRunning, refetch]);

	const startDraft = useCallback(
		(kind: ChangeItemKind) => {
			if (!active || !proposalId || !projectId) {
				return;
			}
			// Optimistic: show the banner immediately rather than waiting a round
			// trip. The server is the source of truth on the next poll.
			setByKind((prev) =>
				prev[kind]?.status === "COMPLETED" ||
				prev[kind]?.status === "RUNNING"
					? prev
					: {
							...prev,
							[kind]: {
								kind,
								status: "RUNNING",
								startedAt: new Date().toISOString(),
								description: null,
								acceptanceCriteria: null,
								needsMoreInfo: null,
							},
						},
			);
			void (async () => {
				try {
					const res = await orpcClient.projects.backlog.drafts.start({
						projectId,
						organizationId: organizationId ?? null,
						proposalId,
						kind,
					});
					setByKind((prev) => ({ ...prev, [kind]: toState(res) }));
				} catch {
					// Surface as FAILED so the UI offers "Draft again".
					setByKind((prev) => ({
						...prev,
						[kind]: {
							kind,
							status: "FAILED",
							startedAt:
								prev[kind]?.startedAt ??
								new Date().toISOString(),
							description: null,
							acceptanceCriteria: null,
							needsMoreInfo: null,
						},
					}));
				}
			})();
		},
		[active, proposalId, projectId, organizationId],
	);

	const cancelDraft = useCallback(
		async (kind: ChangeItemKind) => {
			if (!active || !proposalId || !projectId) {
				return;
			}
			setByKind((prev) =>
				prev[kind]
					? {
							...prev,
							[kind]: { ...prev[kind], status: "CANCELLED" },
						}
					: prev,
			);
			try {
				await orpcClient.projects.backlog.drafts.cancel({
					projectId,
					organizationId: organizationId ?? null,
					proposalId,
					kind,
				});
			} finally {
				void refetch();
			}
		},
		[active, proposalId, projectId, organizationId, refetch],
	);

	return { byKind, startDraft, cancelDraft, active };
}
