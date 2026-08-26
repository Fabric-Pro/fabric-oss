"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@ui/components/switch";
import { AlertCircle, CpuIcon, InfoIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";

export function DelegationSettingsForm() {
	const queryClient = useQueryClient();

	const { data, isLoading, error } = useQuery({
		queryKey: ["userDelegationSettings"],
		queryFn: async () => {
			return await orpcClient.users.delegationSettings.get();
		},
		retry: 1,
	});

	const updateMutation = useMutation({
		mutationFn: async (useDelegatedExecution: boolean) => {
			return await orpcClient.users.delegationSettings.update({
				useDelegatedExecution,
			});
		},
		onSuccess: (result) => {
			toast.success(
				result.useDelegatedExecution
					? "Delegated execution enabled"
					: "Direct execution enabled",
				{
					description: result.useDelegatedExecution
						? "Fabric AI operations will run on the Fabric AI server"
						: "Fabric AI operations will run directly in the worker",
				},
			);
			queryClient.invalidateQueries({
				queryKey: ["userDelegationSettings"],
			});
		},
		onError: () => {
			toast.error("Failed to update execution mode");
		},
	});

	const handleToggle = (checked: boolean) => {
		updateMutation.mutate(checked);
	};

	if (isLoading) {
		return (
			<SettingsItem
				title="Execution Mode"
				description="Choose how Fabric AI operations are executed"
			>
				<div className="text-muted-foreground text-sm">Loading...</div>
			</SettingsItem>
		);
	}

	if (error) {
		return (
			<SettingsItem
				title="Execution Mode"
				description="Choose how Fabric AI operations are executed"
			>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" />
					<span>Failed to load delegation settings</span>
				</div>
			</SettingsItem>
		);
	}

	// Default to delegated execution if data is unavailable
	const useDelegatedExecution = data?.useDelegatedExecution ?? true;

	return (
		<SettingsItem
			title="Execution Mode"
			description="Choose how Fabric AI operations (web search, scraping, pattern execution) are processed"
		>
			<div className="space-y-4">
				<div className="flex flex-row items-center justify-between rounded-lg border p-4">
					<div className="space-y-0.5 flex-1">
						<div className="flex items-center gap-2">
							{useDelegatedExecution ? (
								<ServerIcon className="size-4 text-primary" />
							) : (
								<CpuIcon className="size-4 text-muted-foreground" />
							)}
							<span className="text-base font-medium">
								{useDelegatedExecution
									? "Delegated Execution"
									: "Direct Execution"}
							</span>
						</div>
						<p className="text-sm text-muted-foreground">
							{useDelegatedExecution
								? "Operations run on the Fabric AI server with full capabilities"
								: "Operations run directly in the workflow worker"}
						</p>
					</div>
					<Switch
						checked={useDelegatedExecution}
						onCheckedChange={handleToggle}
						disabled={updateMutation.isPending}
					/>
				</div>

				<div className="rounded-md border border-border bg-muted/40 p-4">
					<div className="flex items-start gap-3">
						<InfoIcon className="mt-0.5 size-5 text-muted-foreground" />
						<div className="flex-1 space-y-2">
							<p className="font-medium text-sm text-foreground">
								About Execution Modes
							</p>
							<div className="text-foreground/70 text-xs space-y-1">
								<p>
									<strong>Delegated (Recommended):</strong>{" "}
									Operations are sent to the Fabric AI server
									which has full access to patterns, contexts,
									and advanced processing. Your API keys are
									securely exchanged via token.
								</p>
								<p>
									<strong>Direct:</strong> Operations run
									locally in the workflow worker. Useful for
									debugging or when the Fabric AI server is
									unavailable.
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</SettingsItem>
	);
}
