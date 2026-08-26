"use client";

import type { StoryKind } from "@repo/database";
import {
	bindableDocumentTypes,
	findPromptAgentTarget,
	isNonStageAgent,
	listPromptActions,
	PROMPT_AGENT_TARGETS,
	promptActionId,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { useSession } from "@saas/auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Link2Icon, Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ActionMultiSelect } from "./ActionMultiSelect";
import { PromptFormatBadge } from "./PromptFormatBadge";
import { PromptScopeBadge } from "./PromptScopeBadge";

const getDocTypeLabel = promptDocumentTypeLabel;

const AGENT_TARGETS = PROMPT_AGENT_TARGETS;

type KindFilter = "ANY" | Extract<StoryKind, "FEATURE" | "BUG">;

/** Mirrors `PromptScope` — the tier a binding is written at. */
type BindingScope = "SYSTEM" | "ORG" | "USER";

/** The dialog's "ANY" maps to a non-stage binding, i.e. `storyKind IS NULL`. */
function toStoryKind(kind: KindFilter): "FEATURE" | "BUG" | null {
	return kind === "ANY" ? null : kind;
}

/**
 * Pick the agent the dialog should open on.
 *
 * Agent-keyed prompts — the ones seeded per AGENT_TARGETS entry — carry their
 * agent in `Prompt.key`, so opening the dialog from one of those has exactly
 * one sensible answer. Seeding from AGENT_TARGETS[0] instead meant a user who
 * chose a document type without noticing the Agent field bound (say) the
 * meeting-agenda prompt as their default PRD prompt; with "set as default"
 * pre-checked that is one unremarkable click away.
 *
 * Ordinary library prompts have keys matching no agent and keep the previous
 * default, so the selector is never empty.
 */
export function resolveInitialAgentKey(promptKey?: string): string {
	return (
		AGENT_TARGETS.find((agent) => agent.key === promptKey)?.key ??
		AGENT_TARGETS[0].key
	);
}

type PromptBindingManagerProps = {
	promptId: string;
	promptName: string;
	promptScope: "SYSTEM" | "ORG" | "USER";
	/** `Prompt.key` — preselects the matching agent when one exists. */
	promptKey?: string;
	organizationId?: string;
};

export function PromptBindingManager({
	promptId,
	promptName,
	promptScope,
	promptKey,
	organizationId,
}: PromptBindingManagerProps) {
	const queryClient = useQueryClient();
	const { user } = useSession();
	// Platform admin (User.role), not an organization admin — the two are
	// unrelated fields, and only this one may set the default every tenant
	// without an override falls back to. The API enforces the same rule; this
	// only decides whether the option is worth offering.
	const canSetSystemDefault = user?.role === "admin";
	const [open, setOpen] = useState(false);
	const [selectedAgent, setSelectedAgent] = useState<string>(() =>
		resolveInitialAgentKey(promptKey),
	);
	const [selectedScope, setSelectedScope] = useState<BindingScope>("USER");
	// Document type is now REQUIRED - no default value, user must select
	const [selectedDocumentType, setSelectedDocumentType] =
		useState<string>("");
	// Kind discriminator for stage bindings. "ANY" maps to NULL (non-stage).
	const [selectedStoryKind, setSelectedStoryKind] =
		useState<KindFilter>("ANY");
	// isDefault flag - whether to set this prompt as the default for the document type
	const [isDefault, setIsDefault] = useState<boolean>(true);

	// Get available document types for selected agent — filtered by storyKind
	// so users can't pick a feature-only stage for a BUG binding.
	const selectedAgentTarget = findPromptAgentTarget(selectedAgent);
	const availableDocumentTypes = selectedAgentTarget
		? bindableDocumentTypes(
				selectedAgentTarget,
				toStoryKind(selectedStoryKind),
			)
		: [];

	// FR19: one prompt can serve several actions. The action chosen above is
	// always included and is not listed here — unticking the thing you came to
	// bind would be a way to bind nothing at all.
	const primaryActionId = selectedDocumentType
		? promptActionId(
				selectedAgent,
				selectedDocumentType,
				toStoryKind(selectedStoryKind),
			)
		: null;
	const additionalActions = useMemo(
		() => listPromptActions().filter((a) => a.id !== primaryActionId),
		[primaryActionId],
	);
	const [alsoApplyTo, setAlsoApplyTo] = useState<string[]>([]);

	// Fetch prompt details to get versions
	const { data: promptDetails, isLoading: isLoadingDetails } = useQuery({
		queryKey: ["prompt", promptId, organizationId],
		queryFn: async () =>
			await orpcClient.prompts.get.byId({
				id: promptId,
				organizationId: organizationId ?? null,
			}),
		enabled: open,
	});

	// Get latest version
	const latestVersion = promptDetails?.versions?.[0];

	// Reset state when dialog opens
	useEffect(() => {
		if (open) {
			// Reset to defaults when dialog opens
			setSelectedAgent(resolveInitialAgentKey(promptKey));
			setSelectedScope("USER");
			setSelectedStoryKind("ANY");
			setSelectedDocumentType("");
			setIsDefault(true); // Default to checked
			// A set of extra actions chosen for one prompt must not follow the
			// dialog to the next one.
			setAlsoApplyTo([]);
		}
	}, [open, promptKey]);

	// Clear the document type when storyKind changes, since the valid options shift.
	useEffect(() => {
		setSelectedDocumentType("");
	}, [selectedStoryKind]);

	// Some agents only ever resolve a NON-STAGE binding (storyKind = null,
	// documentType = GENERAL) at runtime. Picking a kind for one of those empties
	// the doc-type list and strands the user, so lock the selector to "ANY".
	const nonStageAgent = selectedAgentTarget
		? isNonStageAgent(selectedAgentTarget)
		: false;
	useEffect(() => {
		if (nonStageAgent && selectedStoryKind !== "ANY") {
			setSelectedStoryKind("ANY");
		}
	}, [nonStageAgent, selectedStoryKind]);

	// Bind mutation
	const bindMutation = useMutation({
		mutationFn: async () => {
			if (!latestVersion) {
				throw new Error("No version available");
			}

			if (!selectedDocumentType) {
				throw new Error("Document type is required");
			}

			const primary = {
				targetType: "AGENT" as const,
				targetKey: selectedAgent,
				documentType: selectedDocumentType,
				storyKind: toStoryKind(selectedStoryKind),
			};

			const extras = alsoApplyTo
				.map((id) => additionalActions.find((a) => a.id === id))
				.filter((a): a is NonNullable<typeof a> => Boolean(a))
				.map((a) => ({
					targetType: "AGENT" as const,
					targetKey: a.targetKey,
					documentType: a.documentType,
					storyKind: a.storyKind,
				}));

			const organizationIdForScope =
				selectedScope === "ORG" ? (organizationId ?? null) : null;

			// One call when there is one action, so the common case keeps the
			// simpler endpoint; the batch is a transaction, so several actions
			// either all bind or none do.
			if (extras.length === 0) {
				return await orpcClient.prompts.bind.set({
					...primary,
					scope: selectedScope,
					organizationId: organizationIdForScope,
					promptVersionId: latestVersion.id,
					isDefault,
				});
			}

			return await orpcClient.prompts.bind.setMany({
				targets: [primary, ...extras],
				scope: selectedScope,
				organizationId: organizationIdForScope,
				promptVersionId: latestVersion.id,
				isDefault,
			});
		},
		onSuccess: () => {
			toast.success(
				alsoApplyTo.length > 0
					? `Prompt bound to ${alsoApplyTo.length + 1} actions`
					: "Prompt bound successfully",
			);
			setOpen(false);
			// Invalidate relevant queries
			queryClient.invalidateQueries({ queryKey: ["prompts"] });
			queryClient.invalidateQueries({ queryKey: ["prompt-bindings"] });
		},
		onError: (error) => {
			toast.error("Failed to bind prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleBind = () => {
		bindMutation.mutate();
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setOpen(true)}
					>
						<Link2Icon className="mr-2 h-4 w-4" />
						Set as Default
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Use this prompt as the default for a document type</p>
				</TooltipContent>
			</Tooltip>

			<Dialog open={open} onOpenChange={setOpen}>
				{/* Pinned header/footer with only the body scrolling: the action
				    list alone is taller than a short window, and when the whole
				    dialog scrolled the submit button sat below the fold — content
				    visibly "outside" the modal until you went looking for it. */}
				<DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-md">
					<DialogHeader className="shrink-0">
						<DialogTitle>Set as Default Prompt</DialogTitle>
						<DialogDescription>
							Set "{promptName}" as the default prompt for an
							agent and document type.
						</DialogDescription>
					</DialogHeader>

					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4 pr-1">
						{/* Prompt Info */}
						<div className="flex items-center gap-2 p-3 bg-muted rounded-md">
							<div className="flex-1">
								<p className="font-medium text-sm">
									{promptName}
								</p>
								<div className="flex items-center gap-2 mt-1">
									<PromptScopeBadge scope={promptScope} />
									{promptDetails && (
										<PromptFormatBadge
											format={promptDetails.format as any}
										/>
									)}
								</div>
							</div>
						</div>

						{/* Agent Selection */}
						<div className="space-y-2">
							<Label htmlFor="prompt-binding-agent">Agent</Label>
							<Select
								value={selectedAgent}
								onValueChange={(agent) => {
									setSelectedAgent(agent);
									// Reset document type when agent changes
									setSelectedDocumentType("");
								}}
							>
								<SelectTrigger id="prompt-binding-agent">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{AGENT_TARGETS.map((agent) => (
										<SelectItem
											key={agent.key}
											value={agent.key}
										>
											{agent.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								The AI agent that will use this prompt
							</p>
						</div>

						{/* Story Kind — disambiguates shared stages (PLACEHOLDER/DRAFT) */}
						<div className="space-y-2">
							<Label htmlFor="prompt-binding-kind">
								Applies to
							</Label>
							<Select
								value={selectedStoryKind}
								onValueChange={(value) =>
									setSelectedStoryKind(value as KindFilter)
								}
								disabled={nonStageAgent}
							>
								<SelectTrigger id="prompt-binding-kind">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="ANY">
										Any (non-stage)
									</SelectItem>
									<SelectItem value="FEATURE">
										Feature stage
									</SelectItem>
									<SelectItem value="BUG">
										Bug stage
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{nonStageAgent
									? "This agent runs outside the per-kind stage flow, so it always uses a non-stage binding."
									: "Stage bindings are scoped per kind so a Feature and a Bug at the same stage can use different prompts."}
							</p>
						</div>

						{/* Document Type Selection - REQUIRED */}
						<div className="space-y-2">
							<Label htmlFor="prompt-binding-document-type">
								Document Type{" "}
								<span className="text-destructive">*</span>
							</Label>
							<Select
								value={selectedDocumentType}
								onValueChange={(value) =>
									setSelectedDocumentType(value)
								}
							>
								<SelectTrigger
									id="prompt-binding-document-type"
									className={
										!selectedDocumentType
											? "border-destructive"
											: ""
									}
								>
									<SelectValue placeholder="Select document type..." />
								</SelectTrigger>
								<SelectContent>
									{availableDocumentTypes.map((docType) => (
										<SelectItem
											key={docType}
											value={docType}
										>
											{getDocTypeLabel(docType)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{selectedDocumentType
									? `This prompt will be used for ${getDocTypeLabel(selectedDocumentType)} documents`
									: "Each document type requires its own prompt binding"}
							</p>
						</div>

						{/* Scope Selection */}
						<div className="space-y-2">
							<Label htmlFor="prompt-binding-scope">
								Binding Scope
							</Label>
							<Select
								value={selectedScope}
								onValueChange={(val) =>
									setSelectedScope(val as BindingScope)
								}
							>
								<SelectTrigger id="prompt-binding-scope">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="USER">
										Personal (just for me)
									</SelectItem>
									{organizationId && (
										<SelectItem value="ORG">
											Organization (for all members)
										</SelectItem>
									)}
									{canSetSystemDefault && (
										<SelectItem value="SYSTEM">
											System (every organization)
										</SelectItem>
									)}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{selectedScope === "USER"
									? "This will only affect your documents."
									: selectedScope === "ORG"
										? "This will affect all organization members who have not set their own default."
										: "This becomes the default for every organization that has not set its own."}
							</p>
						</div>

						{/* FR19: bind this same prompt to other actions too */}
						{selectedDocumentType && primaryActionId && (
							<ActionMultiSelect
								id="prompt-binding-also"
								label="Also apply to"
								alwaysIncluded={primaryActionId}
								value={alsoApplyTo}
								onChange={setAlsoApplyTo}
								hint={
									alsoApplyTo.length > 0
										? `This prompt will serve ${alsoApplyTo.length + 1} actions. They share one body, so editing it later changes all of them.`
										: "Optional. The action selected above is always included."
								}
							/>
						)}

						{/* Set as Default Checkbox */}
						<div className="flex items-center space-x-2">
							<input
								type="checkbox"
								id="isDefault"
								checked={isDefault}
								onChange={(e) => setIsDefault(e.target.checked)}
								className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
							/>
							<Label
								htmlFor="isDefault"
								className="text-sm font-normal cursor-pointer"
							>
								Set as default prompt for this document type
							</Label>
						</div>
						<p className="text-xs text-muted-foreground">
							{isDefault
								? "This prompt will be automatically selected when creating new documents of this type"
								: "This prompt will be available but not automatically selected"}
						</p>
					</div>

					<DialogFooter className="shrink-0 border-t pt-4">
						<Button
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={handleBind}
							disabled={
								bindMutation.isPending ||
								isLoadingDetails ||
								!latestVersion ||
								!selectedDocumentType // Disable if document type not selected
							}
						>
							{bindMutation.isPending && (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							)}
							Set as Default
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
