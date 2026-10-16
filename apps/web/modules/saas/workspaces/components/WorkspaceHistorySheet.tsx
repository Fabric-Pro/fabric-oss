"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { useToast } from "@ui/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";

/** More entries than any page has had; a longer history is not offered for restore. */
const HISTORY_LIMIT = 500;

const EDIT_LABELS: Record<string, string> = {
	full_update: "Page changed",
	string_replace: "Text replaced",
	revert: "Earlier version restored",
};

function describeEdit(editType: string): string {
	return EDIT_LABELS[editType] ?? "Page changed";
}

/**
 * The versions of a Workspace page. Every change keeps the page as it was
 * before, so each row is one step back, and a restore is a change like any
 * other: it keeps the page it replaced, and can itself be undone.
 */
export function WorkspaceHistorySheet({
	frameId,
	organizationId,
	open,
	onOpenChange,
	onRestored,
}: {
	frameId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestored: () => void;
}) {
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const [restoringVersion, setRestoringVersion] = useState<number | null>(
		null,
	);
	const historyKey = [
		"frame",
		"history",
		frameId,
		organizationId ?? null,
	] as const;

	const history = useQuery({
		queryKey: historyKey,
		queryFn: () =>
			orpcClient.frames.getHistory({
				id: frameId,
				organizationId: organizationId ?? null,
				limit: HISTORY_LIMIT,
			}),
		enabled: open,
	});

	const restore = useMutation({
		mutationFn: (toVersion: number) =>
			orpcClient.frames.revert({
				id: frameId,
				organizationId: organizationId ?? null,
				toVersion,
			}),
		onSuccess: (result) => {
			if (!result.success) {
				toast({
					title: "Could not restore this version",
					description: result.error,
					variant: "destructive",
				});
				return;
			}
			toast({ title: "Earlier version restored" });
			queryClient.invalidateQueries({ queryKey: historyKey });
			onRestored();
		},
		onError: () => {
			toast({
				title: "Could not restore this version",
				description: "Please try again.",
				variant: "destructive",
			});
		},
		onSettled: () => setRestoringVersion(null),
	});

	const entries = history.data?.history ?? [];
	const complete = entries.length < HISTORY_LIMIT;

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>Version history</SheetTitle>
					<SheetDescription>
						Each row is the page as it was before that change.
						Restoring one keeps the page it replaces, so you can go
						back again.
					</SheetDescription>
				</SheetHeader>

				<div className="py-6">
					{history.isLoading ? (
						<output
							className="block space-y-3"
							aria-label="Loading history"
						>
							{[0, 1, 2].map((key) => (
								<Skeleton
									key={key}
									className="h-14 rounded-lg"
								/>
							))}
						</output>
					) : history.isError ? (
						<p role="alert" className="text-sm text-destructive">
							The history could not be loaded.
						</p>
					) : entries.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No earlier versions yet. The first change to the
							page keeps the page as it is now.
						</p>
					) : (
						<ol className="space-y-3">
							{entries.map((entry, index) => {
								const version = entries.length - index;
								const restorable =
									complete &&
									entry.editType !== "string_replace";
								return (
									<li
										key={entry.id}
										className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"
									>
										<div className="min-w-0">
											<p className="text-sm font-medium text-foreground">
												{describeEdit(entry.editType)}
											</p>
											<p className="text-xs text-muted-foreground">
												{formatDistanceToNow(
													new Date(entry.editedAt),
													{ addSuffix: true },
												)}
											</p>
										</div>
										{restorable ? (
											<Button
												variant="outline"
												size="sm"
												disabled={restore.isPending}
												onClick={() => {
													setRestoringVersion(
														version,
													);
													restore.mutate(version);
												}}
											>
												{restoringVersion === version
													? "Restoring..."
													: "Restore the page before"}
											</Button>
										) : null}
									</li>
								);
							})}
						</ol>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
