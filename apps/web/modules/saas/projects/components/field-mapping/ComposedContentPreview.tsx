"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import type { SelectedField } from "./field-mapping-helpers";
import { getOrpcCode } from "./orpc-error";

type Props = {
	projectId: string;
	/** The work item the admin is working from, if they have entered one. */
	workItemId: string;
	selected: SelectedField[];
};

/**
 * Show the body this mapping would actually produce for a real ticket.
 *
 * Choosing fields is otherwise blind — you pick identifiers and only learn what
 * they compose into after a sync writes it. The markdown here is rendered by the
 * SAME server-side function the sync uses, so it cannot drift from what gets
 * stored; the ordering of the selected list is visible in the output, which is
 * what makes reordering meaningful.
 */
export function ComposedContentPreview({
	projectId,
	workItemId,
	selected,
}: Props) {
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const compose = useMutation({
		mutationFn: async () =>
			orpcClient.projects.pm.composeFieldPreview({
				projectId,
				workItemId,
				fields: selected.map((f) => ({
					id: f.id,
					displayName: f.displayName,
				})),
			}),
		onError: (error) => {
			const code = getOrpcCode(error);
			setErrorMessage(
				code === "NOT_FOUND"
					? `Couldn't load ticket #${workItemId}. Check the number and your access.`
					: error instanceof Error
						? error.message
						: "Couldn't compose the preview.",
			);
		},
	});

	const canCompose = Boolean(workItemId.trim()) && selected.length > 0;
	const result = compose.data;

	return (
		<div className="space-y-2 rounded-lg border bg-muted/30 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<p className="font-medium text-foreground text-sm">
						Composed content
					</p>
					<p className="mt-0.5 text-muted-foreground text-xs">
						Exactly what a sync would write for this ticket, using
						the selected fields in their current order.
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => {
						setErrorMessage(null);
						compose.mutate();
					}}
					disabled={compose.isPending || !canCompose}
				>
					{compose.isPending ? (
						<>
							<Loader2Icon
								className="mr-2 size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							Composing...
						</>
					) : (
						"Preview content"
					)}
				</Button>
			</div>

			{!canCompose && (
				<p className="text-muted-foreground text-xs italic">
					Enter a ticket number above and select at least one field.
				</p>
			)}

			{errorMessage && (
				<p className="text-destructive text-sm" role="alert">
					{errorMessage}
				</p>
			)}

			{result && !compose.isPending && !errorMessage && (
				<>
					{result.emptyFieldIds.length > 0 && (
						<p className="text-muted-foreground text-xs">
							{result.emptyFieldIds.length} selected field
							{result.emptyFieldIds.length === 1 ? "" : "s"}{" "}
							contribute nothing here — empty on this ticket:{" "}
							<span className="font-mono">
								{result.emptyFieldIds.join(", ")}
							</span>
						</p>
					)}
					{result.markdown ? (
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-card p-3 font-sans text-foreground text-sm">
							{result.markdown}
						</pre>
					) : (
						<p className="text-muted-foreground text-sm italic">
							Every selected field is empty on this ticket, so the
							mapping would produce no content.
						</p>
					)}
				</>
			)}
		</div>
	);
}
