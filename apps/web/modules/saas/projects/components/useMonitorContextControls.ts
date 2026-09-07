"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

/**
 * The pause / unlink-fork / reconnect trio shared by the three context-source
 * monitor panels — Teams channels, Teams chats and Slack channels (Fizzy #2355).
 *
 * The three panels are near-identical and were drifting apart one copy-edit at a
 * time; the destructive confirmation in particular has to say the same thing in
 * all three or the safest path is only safe on some screens. Everything
 * provider-specific arrives as a callback, so this file knows nothing about
 * Graph, Slack or oRPC routes.
 */

/** One linked conversation, reduced to what these controls need. */
export type MonitorRow = {
	id: string;
	/** Human label for messages — a channel or chat title, never an id. */
	label: string;
	/** Non-null while scanning is paused. */
	deactivatedAt: string | Date | null;
};

type ReconnectReport = {
	total: number;
	reachableCount: number;
	unreachableLabels: string[];
	indeterminateLabels: string[];
};

export type MonitorContextControlsParams = {
	/** "chat" or "channel" — used verbatim in confirmations and toasts. */
	noun: string;
	setActive: (params: { id: string; active: boolean }) => Promise<unknown>;
	unlink: (id: string) => Promise<unknown>;
	reconnect: (preflightOnly: boolean) => Promise<ReconnectReport>;
	/** Refetch whatever the panel renders from. */
	invalidate: () => void;
};

export function useMonitorContextControls({
	noun,
	setActive,
	unlink,
	reconnect,
	invalidate,
}: MonitorContextControlsParams) {
	const { confirm } = useConfirmationAlert();

	const setActiveMutation = useMutation({
		mutationFn: setActive,
		onSuccess: (_result, variables) => {
			toast.success(
				variables.active
					? "Scanning resumed"
					: "Scanning paused — nothing was deleted",
			);
			invalidate();
		},
		onError: (error) => {
			toast.error(`Could not change scanning for this ${noun}`, {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const unlinkMutation = useMutation({
		mutationFn: unlink,
		onSuccess: () => {
			toast.success(`${noun === "chat" ? "Chat" : "Channel"} unlinked`);
			invalidate();
		},
		onError: (error) => {
			toast.error(`Failed to unlink ${noun}`, {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const reconnectMutation = useMutation({ mutationFn: reconnect });

	const toggleScanning = useCallback(
		(row: MonitorRow) => {
			setActiveMutation.mutate({
				id: row.id,
				active: row.deactivatedAt !== null,
			});
		},
		[setActiveMutation],
	);

	/**
	 * The destructive confirmation is a FORK, not a yes/no.
	 *
	 * Pausing takes focus, so the reflex of hitting Enter on a dialog keeps the
	 * context rather than destroying it — a project lost roughly 200 meetings to
	 * a warning popup dismissed at speed, and this is the same popup for
	 * conversations. A paused row is offered no fork: there is no safer thing
	 * left to suggest.
	 */
	const requestUnlink = useCallback(
		(row: MonitorRow) => {
			const paused = row.deactivatedAt !== null;
			confirm({
				title: `Unlink ${noun}`,
				message: `Remove ${row.label} from the monitor? This permanently deletes the conversation context captured from it and its indexed content. Existing proposals are kept.`,
				destructive: true,
				confirmLabel: "Unlink and delete context",
				...(paused
					? {}
					: {
							secondaryAction: {
								label: "Pause scanning, keep context",
								onSelect: async () => {
									await setActiveMutation.mutateAsync({
										id: row.id,
										active: false,
									});
								},
							},
						}),
				onConfirm: async () => {
					await unlinkMutation.mutateAsync(row.id);
				},
			});
		},
		[confirm, noun, setActiveMutation, unlinkMutation],
	);

	/**
	 * Reconnect leads with the read-only preflight, so the confirmation can name
	 * what the caller cannot see BEFORE anything is rebound. Rebinding to someone
	 * with narrower access silently shrinks what the project collects, and a
	 * shrunken monitor is indistinguishable from a healthy one.
	 */
	const requestReconnect = useCallback(async () => {
		let report: ReconnectReport;
		try {
			report = await reconnectMutation.mutateAsync(true);
		} catch (error) {
			toast.error("Could not check your access", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
			return;
		}

		const lines = [
			`${report.reachableCount} of ${report.total} ${noun}s would keep scanning under your account.`,
		];
		if (report.unreachableLabels.length > 0) {
			lines.push(
				`You cannot see: ${report.unreachableLabels.join(", ")}. ${
					report.unreachableLabels.length === 1 ? "It" : "They"
				} would stop collecting new messages, but nothing already captured is deleted.`,
			);
		}
		if (report.indeterminateLabels.length > 0) {
			// "We could not check" is not "you cannot see it" — saying the
			// latter would recommend against a reconnect that would work.
			lines.push(
				`Could not check: ${report.indeterminateLabels.join(", ")}.`,
			);
		}

		confirm({
			title: "Reconnect this monitor to you",
			message: lines.join(" "),
			confirmLabel: "Reconnect",
			onConfirm: async () => {
				try {
					await reconnectMutation.mutateAsync(false);
					toast.success("Monitor reconnected to your account");
					invalidate();
				} catch (error) {
					toast.error("Could not reconnect the monitor", {
						description:
							error instanceof Error
								? error.message
								: "Unknown error",
					});
				}
			},
		});
	}, [confirm, invalidate, noun, reconnectMutation]);

	return {
		requestUnlink,
		toggleScanning,
		requestReconnect,
		isUnlinking: unlinkMutation.isPending,
		isTogglingScanning: setActiveMutation.isPending,
		isReconnecting: reconnectMutation.isPending,
	};
}
