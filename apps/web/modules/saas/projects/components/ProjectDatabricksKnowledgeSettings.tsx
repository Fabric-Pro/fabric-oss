"use client";

/**
 * ProjectDatabricksKnowledgeSettings
 *
 * Project settings card binding the project to a Databricks Vector Search
 * integration + a set of its indexes (read-only knowledge). Once connected:
 * (1) `search_databricks_indexes` becomes available to chat/agent flows in
 * this project, and (2) "Update using context" retrieval folds Databricks
 * hits in as an additional ranked source. Freely reconnectable — no lock-in.
 *
 * Reuses the agent-builder's DatabricksIndexPicker; visible only when the
 * workspace has an active DATABRICKS_VECTOR_SEARCH connection (discovery is
 * tenant-level, so any org member sees an org-shared connection).
 */

import {
	DatabricksIndexPicker,
	type DatabricksIndexSelection,
} from "@saas/workflows/components/integrations/DatabricksIndexPicker";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { DatabaseZapIcon, Loader2Icon, UnlinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
};

export function ProjectDatabricksKnowledgeSettings({
	projectId,
	organizationId,
	canEdit,
}: Props) {
	const queryClient = useQueryClient();
	const [selection, setSelection] = useState<
		DatabricksIndexSelection | undefined
	>(undefined);
	const [dirty, setDirty] = useState(false);

	const bindingQueryKey = [
		"project-databricks-knowledge",
		projectId,
		organizationId,
	];

	const { data: bindingData, isLoading: bindingLoading } = useQuery({
		queryKey: bindingQueryKey,
		queryFn: async () =>
			await orpcClient.projects.databricksKnowledge.get({
				projectId,
				organizationId,
			}),
	});
	const binding = bindingData?.binding ?? null;

	// Discovery is tenant-level (org-shared) and cheap when nothing is
	// connected ({ isConnected: false }). Pin discovery to the bound
	// integration when one exists so re-running it can't silently resolve to
	// a different connection.
	const { data: indexData } = useQuery({
		queryKey: [
			"databricks-vector-indexes",
			organizationId,
			binding?.integrationId ?? null,
		],
		queryFn: async () =>
			await orpcClient.workflows.integrations.listDatabricksIndexes({
				organizationId,
				integrationId: binding?.integrationId,
			}),
		enabled: !bindingLoading,
		staleTime: 5 * 60 * 1000,
	});

	// Seed the picker from the persisted binding once loaded (and re-seed
	// after save/disconnect), unless the user has local edits in flight.
	useEffect(() => {
		if (dirty) {
			return;
		}
		setSelection(
			binding
				? { schema: binding.schema, indexes: binding.indexNames }
				: undefined,
		);
	}, [binding, dirty]);

	const saveMutation = useMutation({
		mutationFn: async (next: DatabricksIndexSelection) => {
			const integrationId =
				binding?.integrationId ?? indexData?.integrationId;
			if (!integrationId) {
				throw new Error(
					"Databricks Vector Search is not connected for this workspace",
				);
			}
			return await orpcClient.projects.databricksKnowledge.save({
				projectId,
				organizationId,
				integrationId,
				schema: next.schema,
				indexes: next.indexes,
			});
		},
		onSuccess: () => {
			toast.success("Databricks knowledge connected");
			setDirty(false);
			queryClient.invalidateQueries({ queryKey: bindingQueryKey });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to save Databricks knowledge binding",
			);
		},
	});

	const disconnectMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.projects.databricksKnowledge.delete({
				projectId,
				organizationId,
			}),
		onSuccess: () => {
			toast.success("Databricks knowledge disconnected");
			setDirty(false);
			queryClient.invalidateQueries({ queryKey: bindingQueryKey });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to disconnect Databricks knowledge",
			);
		},
	});

	// No active Databricks connection in this workspace and nothing bound —
	// nothing to configure here, so stay out of the way entirely.
	if (!binding && indexData && !indexData.isConnected) {
		return null;
	}

	const canSave =
		canEdit &&
		!!selection?.schema &&
		(selection?.indexes.length ?? 0) > 0 &&
		dirty;

	return (
		<Card
			className="p-6"
			data-onboarding-target="project-databricks-knowledge"
		>
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-start gap-3">
					<div className="rounded-xl border border-border bg-muted p-2">
						<DatabaseZapIcon
							className="h-5 w-5 text-muted-foreground"
							aria-hidden
						/>
					</div>
					<div>
						<div className="flex items-center gap-2">
							<h4 className="font-semibold">
								Databricks knowledge
							</h4>
							{binding ? (
								<Badge status="success">Connected</Badge>
							) : (
								<Badge status="info">Not connected</Badge>
							)}
						</div>
						<p className="mt-1 text-sm text-muted-foreground">
							Bind this project to your Databricks Vector Search
							indexes (read-only). Agents get a search tool, and
							"Update using context" folds matching chunks in as
							an external source.
						</p>
					</div>
				</div>
				{binding && canEdit && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => disconnectMutation.mutate()}
						disabled={disconnectMutation.isPending}
					>
						{disconnectMutation.isPending ? (
							<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<UnlinkIcon className="mr-2 h-4 w-4" />
						)}
						Disconnect
					</Button>
				)}
			</div>

			{indexData?.isConnected ? (
				<div className="mt-4 space-y-4">
					<DatabricksIndexPicker
						schemas={indexData.schemas}
						selection={selection}
						onSelectionChange={(next) => {
							setSelection(next);
							setDirty(true);
						}}
						limitScopeLabel="per project"
						disabled={!canEdit}
					/>
					{canEdit && (
						<Button
							size="sm"
							onClick={() => {
								if (selection) {
									saveMutation.mutate(selection);
								}
							}}
							disabled={!canSave || saveMutation.isPending}
						>
							{saveMutation.isPending && (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							)}
							{binding ? "Update binding" : "Connect indexes"}
						</Button>
					)}
				</div>
			) : (
				<p className="mt-4 text-sm text-muted-foreground">
					{indexData?.error ??
						(binding
							? "The Databricks connection bound to this project is no longer available. Reconnect it in Settings > Integrations."
							: "Checking Databricks Vector Search connection…")}
				</p>
			)}
		</Card>
	);
}
