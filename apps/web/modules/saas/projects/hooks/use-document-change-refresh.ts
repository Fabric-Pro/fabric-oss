"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { getDocumentsPollInterval } from "../lib/document-pipeline";
import type { DocumentChangeEvent } from "./useProjectRealtime";

/**
 * How long the first `document_change` waits for the ones behind it before
 * the project and its documents list are read again.
 */
export const DOCUMENT_CHANGE_REFRESH_GATHER_MS = 2_000;

/**
 * Reads the project and its documents list again after a `document_change`
 * on the page's presence connection, so a generation run's version step
 * reaches an open list's version number without waiting for a focus refetch,
 * and the overview's document inventory follows a run (Fizzy #2946).
 *
 * A run nudges every live section, about every 1.5 s, and the list's answer
 * carries every document's body, so neither is read once per nudge. The
 * first event of a burst starts a short gather; later events join it rather
 * than push it back, and at its end each query is invalidated once. A steady
 * stream of nudges therefore costs one read of each per window.
 *
 * Neither read cancels one already in flight (`cancelRefetch: false`): a
 * list read slower than the gather would otherwise be cancelled by the next
 * one again and again, leaving the list unchanged until the run ended while
 * the server still answered every cancelled request in full. And the list is
 * left alone while it polls on its own — a document is queued or generating —
 * as its next poll is already on the way. Invalidation refetches a query only
 * while something on the page reads it; otherwise its cached copy is just
 * marked stale.
 *
 * The callback keeps one identity for the component's life: the page's
 * realtime connection reconnects whenever its handler changes, and the
 * organization id resolves after the first render. The ids are read when the
 * gather ends, so the keys match what the page reads at that moment.
 */
export function useDocumentChangeRefresh({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}): (event: DocumentChangeEvent) => void {
	const queryClient = useQueryClient();
	const idsRef = useRef({ projectId, organizationId });
	idsRef.current = { projectId, organizationId };
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		},
		[],
	);

	return useCallback(
		(event: DocumentChangeEvent) => {
			if (event.projectId !== idsRef.current.projectId) {
				return;
			}
			if (timerRef.current !== null) {
				return;
			}
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				const { projectId: id, organizationId: orgId } = idsRef.current;
				void queryClient.invalidateQueries(
					{
						queryKey: orpc.projects.get.queryKey({
							input: { id, organizationId: orgId },
						}),
					},
					{ cancelRefetch: false },
				);
				const listKey = orpc.projects.documents.list.queryKey({
					input: { projectId: id, organizationId: orgId },
				});
				const listed = queryClient.getQueryData(listKey)?.documents;
				if (getDocumentsPollInterval(listed) !== false) {
					return;
				}
				void queryClient.invalidateQueries(
					{ queryKey: listKey },
					{ cancelRefetch: false },
				);
			}, DOCUMENT_CHANGE_REFRESH_GATHER_MS);
		},
		[queryClient],
	);
}
