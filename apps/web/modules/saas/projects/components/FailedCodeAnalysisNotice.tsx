"use client";

import { ORPCError } from "@orpc/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, Loader2, RefreshCwIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

/**
 * The project's code analysis failed. Someone who may edit the project can run
 * it again over the repositories the project is connected to (Fizzy #3429);
 * anyone else only reads that it failed.
 */
export function FailedCodeAnalysisNotice({
	projectId,
	organizationId,
	canRetry,
	onRetried,
	onDismiss,
}: {
	projectId: string;
	organizationId: string | null | undefined;
	canRetry: boolean;
	/** The analysis started again: the page reads its status again. */
	onRetried: () => void;
	onDismiss: () => void;
}) {
	const retry = useMutation({
		mutationFn: () =>
			orpcClient.projects.existingSetup.retry({
				projectId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			onRetried();
		},
		onError: (error) => {
			toast.error("Could not run the code analysis again", {
				// Only the server's deliberate refusals are shown as written;
				// anything unexpected gets a fixed sentence.
				description:
					error instanceof ORPCError &&
					(error.code === "CONFLICT" || error.code === "BAD_REQUEST")
						? error.message
						: "Something went wrong. Try again in a moment.",
			});
		},
	});

	return (
		<div
			role="alert"
			className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2"
		>
			<AlertTriangleIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-destructive"
			/>
			<p className="min-w-0 flex-1 font-medium text-destructive text-sm">
				The code analysis failed.
			</p>
			{canRetry && (
				<Button
					size="sm"
					variant="outline"
					onClick={() => retry.mutate()}
					disabled={retry.isPending}
					className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10"
				>
					{retry.isPending ? (
						<Loader2
							aria-hidden="true"
							className="size-4 animate-spin"
						/>
					) : (
						<RefreshCwIcon aria-hidden="true" className="size-4" />
					)}
					Run again
				</Button>
			)}
			<button
				type="button"
				onClick={onDismiss}
				aria-label="Dismiss"
				className="shrink-0 text-muted-foreground hover:text-foreground"
			>
				<XIcon aria-hidden="true" className="size-4" />
			</button>
		</div>
	);
}
