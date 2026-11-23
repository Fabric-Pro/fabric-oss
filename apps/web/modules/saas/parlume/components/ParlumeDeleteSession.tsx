"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	HISTORY_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	SUGGESTIONS_QUERY_KEY,
} from "../lib/query-keys";

/**
 * Deletes a finished meeting's transcript, requests and suggestions once the
 * member confirms. The meeting notes stay.
 */
export function ParlumeDeleteSession({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId: string;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (confirming) {
			cancelRef.current?.focus();
		}
	}, [confirming]);

	const remove = async () => {
		setError(null);
		setDeleting(true);
		try {
			await orpcClient.projects.parlume.deleteSession({
				projectId,
				sessionId,
			});
			setConfirming(false);
			await Promise.all(
				[
					SESSIONS_QUERY_KEY,
					HISTORY_QUERY_KEY,
					SUGGESTIONS_QUERY_KEY,
				].map((key) =>
					queryClient.invalidateQueries({
						queryKey: [key, projectId],
					}),
				),
			);
		} catch (cause) {
			setError(
				cause instanceof Error && cause.message
					? cause.message
					: "The session could not be deleted. Try again.",
			);
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div className="space-y-2">
			{confirming ? (
				<fieldset
					aria-label="Confirm deletion"
					className="flex min-w-0 max-w-2xl flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 px-3.5 py-3"
				>
					<span className="text-sm">
						This deletes the transcript, requests, proposed changes
						and suggestions of this meeting. They cannot be
						restored. The notes stay.
					</span>
					<span className="flex gap-2">
						<Button
							ref={cancelRef}
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setConfirming(false)}
						>
							Keep session
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							disabled={deleting}
							onClick={remove}
						>
							Delete now
						</Button>
					</span>
				</fieldset>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="border-destructive/35 text-destructive hover:border-destructive hover:bg-destructive/5"
					onClick={() => setConfirming(true)}
				>
					<Trash2Icon aria-hidden="true" />
					Delete session
				</Button>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
