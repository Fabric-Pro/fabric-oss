"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useOfferedPromptActions } from "../hooks/use-offered-prompt-actions";

type Row = {
	targetKey: string;
	documentType: string;
	storyKind: "BUG" | "FEATURE" | null;
	actionLabel: string;
	promptId: string;
	promptName: string;
	promptVersionId: string;
	updatedAt: string | Date;
};

/**
 * "My Overrides" (Fizzy #2068 F8): every personal default the signed-in user
 * holds, across all actions, with a way to hand each one back.
 *
 * Personal defaults follow the user across organizations, so this list is the
 * same whatever context it is opened in. Clearing is the catalog's own
 * soft-clear: the binding stays available and can be put back from the
 * action's entry, so the confirm says "hand back", not "delete".
 *
 * A personal default at an action the Proposal artifact supersedes does not
 * run for a Proposal in this organization (Fizzy #2946). It is still listed,
 * says so, and can still be handed back: it follows its owner, and runs again
 * in any organization with the gate off.
 */
export function MyOverridesList({ basePath }: { basePath: string }) {
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	const { isSuperseded } = useOfferedPromptActions();
	const tSuperseded = useTranslations(
		"projects.proposalArtifact.supersededAction",
	);

	const query = useQuery(
		orpc.prompts.bindings.listMine.queryOptions({ input: {} }),
	);

	const clear = useMutation({
		mutationFn: async (row: Row) =>
			orpcClient.prompts.bindings.clear({
				targetType: "AGENT",
				targetKey: row.targetKey,
				documentType: row.documentType,
				storyKind: row.storyKind,
				scope: "USER",
			}),
		onSuccess: () => {
			toast.success("Override cleared — the tier beneath now applies");
			queryClient.invalidateQueries({
				queryKey: orpc.prompts.bindings.listMine.queryOptions({
					input: {},
				}).queryKey,
			});
		},
		onError: (error) => {
			toast.error("Could not clear the override", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handBack = (row: Row) => {
		confirm({
			title: `Hand back ${row.actionLabel}?`,
			message: `${row.promptName} stops being your default for this action; the organization or System default applies again. The override stays available here and you can put it back.`,
			confirmLabel: "Hand back",
			onConfirm: () => {
				clear.mutate(row);
			},
		});
	};

	if (query.isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
				<Skeleton className="h-12 w-full" />
			</div>
		);
	}

	if (query.isError) {
		return (
			<p className="text-destructive text-sm">
				Could not load your overrides. Try refreshing the page.
			</p>
		);
	}

	const rows: Row[] = query.data ?? [];

	if (rows.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				No personal overrides. You are running the System or
				organization default everywhere. Set one from any action in the{" "}
				<Link
					href={`${basePath}/prompts/catalog`}
					className="underline"
				>
					catalog
				</Link>
				.
			</p>
		);
	}

	return (
		<ul
			className="divide-y rounded-md border"
			aria-label="My personal default overrides"
		>
			{rows.map((row) => (
				<li
					key={`${row.targetKey}:${row.documentType}:${row.storyKind ?? "any"}`}
					className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
				>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">
							{row.actionLabel}
						</p>
						<p className="truncate text-muted-foreground text-xs">
							<Link
								href={`${basePath}/prompts/${row.promptId}`}
								className="hover:underline"
							>
								{row.promptName}
							</Link>
						</p>
						{isSuperseded(row.targetKey, row.documentType) && (
							<p
								data-testid="my-override-superseded-note"
								className="text-muted-foreground text-xs"
							>
								{tSuperseded("actionNote")}
							</p>
						)}
					</div>
					<Button
						variant="ghost"
						size="sm"
						disabled={clear.isPending}
						onClick={() => handBack(row)}
					>
						Hand back
					</Button>
				</li>
			))}
		</ul>
	);
}
