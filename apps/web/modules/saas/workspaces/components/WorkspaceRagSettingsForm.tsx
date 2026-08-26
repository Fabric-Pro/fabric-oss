"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { GlassCard } from "@saas/shared/components/GlassCard";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Slider } from "@ui/components/slider";
import {
	Loader2Icon,
	RefreshCwIcon,
	SaveIcon,
	SearchIcon,
	SettingsIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Props = {
	workspaceId: string;
	/** When true, shows a more compact layout without the main header */
	compact?: boolean;
};

type RagSettings = {
	topK: number;
	similarityThreshold: number;
};

export function WorkspaceRagSettingsForm({
	workspaceId,
	compact = false,
}: Props) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();

	const { data, isLoading } = useQuery(
		orpc.documentWorkspaces.ragSettings.get.queryOptions({
			input: { workspaceId, organizationId },
		}),
	);

	const [settings, setSettings] = useState<RagSettings>({
		topK: 5,
		similarityThreshold: 0.5,
	});

	const [hasChanges, setHasChanges] = useState(false);

	// Sync settings from API
	useEffect(() => {
		if (data?.settings) {
			setSettings({
				topK: data.settings.topK,
				similarityThreshold: data.settings.similarityThreshold,
			});
			setHasChanges(false);
		}
	}, [data?.settings]);

	const updateMutation = useMutation(
		orpc.documentWorkspaces.ragSettings.update.mutationOptions({
			onSuccess: () => {
				toast.success("RAG settings saved successfully");
				queryClient.invalidateQueries({
					queryKey: orpc.documentWorkspaces.ragSettings.get.queryKey({
						input: { workspaceId, organizationId },
					}),
				});
				setHasChanges(false);
			},
			onError: (error) => {
				toast.error(`Failed to save settings: ${error.message}`);
			},
		}),
	);

	const updateSetting = <K extends keyof RagSettings>(
		key: K,
		value: RagSettings[K],
	) => {
		setSettings((prev) => ({ ...prev, [key]: value }));
		setHasChanges(true);
	};

	const handleSave = () => {
		updateMutation.mutate({
			workspaceId,
			organizationId,
			...settings,
		});
	};

	const handleReset = () => {
		if (data?.settings) {
			setSettings({
				topK: data.settings.topK,
				similarityThreshold: data.settings.similarityThreshold,
			});
			setHasChanges(false);
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Loader2Icon className="size-6 animate-spin text-foreground/50" />
			</div>
		);
	}

	return (
		<div className={compact ? "space-y-4" : "space-y-6"}>
			{/* Header - only shown when not compact */}
			{!compact && (
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 p-2.5">
							<SettingsIcon className="size-5 text-white" />
						</div>
						<div>
							<h2 className="font-semibold text-xl">
								RAG Settings
							</h2>
							<p className="text-foreground/50 text-sm">
								Configure how documents are searched and
								retrieved
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2">
						{hasChanges && (
							<Button
								variant="outline"
								size="sm"
								onClick={handleReset}
							>
								<RefreshCwIcon className="mr-2 size-4" />
								Reset
							</Button>
						)}
						<Button
							size="sm"
							onClick={handleSave}
							disabled={!hasChanges || updateMutation.isPending}
							className="gap-2 bg-gradient-to-r from-primary to-violet-500 hover:from-primary/90 hover:to-violet-500/90"
						>
							<SaveIcon className="size-4" />
							{updateMutation.isPending
								? "Saving..."
								: "Save Changes"}
						</Button>
					</div>
				</div>
			)}

			{/* Compact mode: show save button at top */}
			{compact && hasChanges && (
				<div className="flex items-center justify-end gap-2">
					<Button variant="outline" size="sm" onClick={handleReset}>
						<RefreshCwIcon className="mr-2 size-4" />
						Reset
					</Button>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={updateMutation.isPending}
						className="gap-2 bg-gradient-to-r from-primary to-violet-500 hover:from-primary/90 hover:to-violet-500/90"
					>
						<SaveIcon className="size-4" />
						{updateMutation.isPending
							? "Saving..."
							: "Save Changes"}
					</Button>
				</div>
			)}

			{/* Retrieval Settings */}
			<GlassCard gradient="from-amber-500/5 to-orange-500/5">
				<div
					className={`flex items-center gap-2 ${compact ? "mb-3" : "mb-4"}`}
				>
					<div
						className={`rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 ${compact ? "p-1.5" : "p-2"}`}
					>
						<SearchIcon
							className={
								compact
									? "size-3.5 text-white"
									: "size-4 text-white"
							}
						/>
					</div>
					<h3
						className={
							compact ? "font-medium text-sm" : "font-semibold"
						}
					>
						Retrieval Settings
					</h3>
				</div>

				<div className={compact ? "space-y-4" : "space-y-6"}>
					{/* Top K */}
					<div className={compact ? "space-y-2" : "space-y-3"}>
						<div className="flex items-center justify-between">
							<Label className={compact ? "text-xs" : ""}>
								Top K Results
							</Label>
							<span className="font-mono text-primary text-sm">
								{settings.topK} chunks
							</span>
						</div>
						<Slider
							value={[settings.topK]}
							onValueChange={([value]) =>
								updateSetting("topK", value)
							}
							min={1}
							max={20}
							step={1}
							className="py-2"
						/>
						<p className="text-foreground/50 text-xs">
							Number of most relevant document chunks to retrieve
							for each query
						</p>
					</div>

					{/* Similarity Threshold */}
					<div className={compact ? "space-y-2" : "space-y-3"}>
						<div className="flex items-center justify-between">
							<Label className={compact ? "text-xs" : ""}>
								Similarity Threshold
							</Label>
							<span className="font-mono text-primary text-sm">
								{(settings.similarityThreshold * 100).toFixed(
									0,
								)}
								%
							</span>
						</div>
						<Slider
							value={[settings.similarityThreshold]}
							onValueChange={([value]) =>
								updateSetting("similarityThreshold", value)
							}
							min={0.1}
							max={0.9}
							step={0.05}
							className="py-2"
						/>
						<p className="text-foreground/50 text-xs">
							Minimum similarity score for retrieved chunks.
							Higher values mean more relevant but fewer results.
						</p>
					</div>
				</div>
			</GlassCard>

			{/* Help text */}
			<div className="rounded-lg border border-foreground/10 bg-foreground/5 p-4">
				<p className="text-foreground/60 text-sm">
					These settings control how document content is searched when
					you ask questions. Adjusting these values can help improve
					the relevance and accuracy of AI responses based on your
					workspace documents.
				</p>
			</div>
		</div>
	);
}
