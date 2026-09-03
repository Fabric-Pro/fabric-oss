"use client";

import type { StoryKind } from "@repo/database";
import { promptActionId } from "@repo/utils/prompt-action-catalog";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
	Select as ScopeSelect,
	SelectContent as ScopeSelectContent,
	SelectItem as ScopeSelectItem,
	SelectTrigger as ScopeSelectTrigger,
	SelectValue as ScopeSelectValue,
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckCircle2,
	EyeIcon,
	GitFork,
	LibraryIcon,
	Link2Icon,
	Loader2Icon,
	SettingsIcon,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PromptPreviewSheet } from "./PromptPreviewSheet";

interface PromptSelectorProps {
	agentName: string;
	/** The project this selector renders inside. Set, an org admin may bind
	 *  the prompt as THIS project's default (the PROJECT tier). */
	projectId?: string | null;
	documentType?: string;
	/** When set, scopes the selector to bindings with this exact storyKind.
	 *  Required when offering stage prompts (PLACEHOLDER/DRAFT/...) so a
	 *  Bug doesn't surface Feature prompts and vice versa. */
	storyKind?: StoryKind;
	value?: string;
	onValueChange: (promptId: string | undefined) => void;
	/** Called when prompt selection changes, with the latest version ID for attribution */
	onPromptVersionChange?: (promptVersionId: string | undefined) => void;
	disabled?: boolean;
	placeholder?: string;
	/** Show "Bind as Default" button next to the selector */
	showBindAction?: boolean;
	/**
	 * Hide the inline "Manage prompts" gear icon. The page-level chrome can
	 * render its own equivalent action (the document editor moves it onto the
	 * masthead action bar so this becomes redundant).
	 */
	hideManagePromptsAction?: boolean;
	/**
	 * Render the selector + its trailing actions in a compact size to match a
	 * 32-px-tall action row (the document editor's prompt row). When `false`
	 * (default), the standard Radix Select trigger height (`h-9`, `text-base`)
	 * is preserved so existing form-style usages keep their look.
	 */
	compact?: boolean;
	/** Constrain tooltip positioning to stay inside a specific element (e.g. a dialog) */
	tooltipCollisionBoundaryRef?: React.RefObject<HTMLElement | null>;
	/**
	 * Put on the select trigger so a caller's visible `<Label htmlFor=…>` can
	 * point at it.
	 *
	 * Without this the trigger had no accessible name at all. Its content is an
	 * icon plus the selected prompt, so a screen reader announced the *value*
	 * and never what the control was for — and a caller rendering a visible
	 * label beside it had nothing to associate, because the id it would target
	 * was generated inside Radix and never surfaced.
	 */
	triggerId?: string;
	/**
	 * Accessible name for the trigger, when no visible label is available to
	 * associate. Falls back to a generic one rather than staying unnamed: an
	 * unlabelled combobox is a WCAG 4.1.2 failure, and every caller forgetting
	 * the prop should not be the difference.
	 *
	 * The fallback is suppressed once `triggerId` is set, because `aria-label`
	 * outranks a `<label for>` association — see the trigger below.
	 */
	ariaLabel?: string;
}

export function PromptSelector({
	agentName,
	documentType,
	storyKind,
	projectId,
	value,
	onValueChange,
	onPromptVersionChange,
	disabled = false,
	placeholder = "Use default prompt",
	showBindAction = false,
	hideManagePromptsAction = false,
	compact = false,
	tooltipCollisionBoundaryRef,
	triggerId,
	ariaLabel,
}: PromptSelectorProps) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.prompts");
	const { organizationId, isOrgContext, basePath } = useOrganizationContext();
	const { isOrganizationAdmin } = useActiveOrganization();
	const [bindDialogOpen, setBindDialogOpen] = useState(false);
	const [selectedScope, setSelectedScope] = useState<
		"USER" | "ORG" | "PROJECT"
	>("USER");
	const [previewOpen, setPreviewOpen] = useState(false);
	const [previewPromptId, setPreviewPromptId] = useState<string | null>(null);

	// Fetch available prompts for this agent
	// Uses binding-first architecture: only bound prompts are returned
	const { data, isLoading } = useQuery(
		orpc.prompts.agents.available.queryOptions({
			input: {
				agentName,
				documentType,
				storyKind,
				organizationId: organizationId ?? null,
				// Inside a project, the list has to rank that project's default
				// the way the agent will when it runs there.
				projectId: projectId ?? null,
			},
		}),
	);

	// Deduplicate prompts by ID (API may return the same prompt via multiple bindings)
	const prompts = (data?.prompts ?? []).filter(
		(p, i, arr) => arr.findIndex((q) => q.id === p.id) === i,
	);

	// Group prompts by scope
	const systemPrompts = prompts.filter((p) => p.scope === "SYSTEM");
	const orgPrompts = prompts.filter((p) => p.scope === "ORG");
	const userPrompts = prompts.filter((p) => p.scope === "USER");

	// Find the default prompt (marked with isDefault: true)
	const defaultPrompt = prompts.find((p) => p.isDefault);

	// Effective value: use explicit selection, or fall back to default prompt
	// This avoids calling parent setState during mount (which causes infinite loops)
	const effectiveValue = value ?? defaultPrompt?.id;

	// Find the currently selected prompt using effective value
	const selectedPrompt = prompts.find((p) => p.id === effectiveValue);

	// Notify parent of the default prompt selection once after data loads.
	// Uses a ref to guarantee it fires at most once per mount.
	const hasNotifiedDefault = useRef(false);
	useEffect(() => {
		if (hasNotifiedDefault.current || isLoading || value) {
			return;
		}
		const id = defaultPrompt?.id;
		const versionId = defaultPrompt?.latestVersion?.id;
		if (!id) {
			return;
		}
		hasNotifiedDefault.current = true;
		// Defer to next microtask to avoid setState-during-render issues
		queueMicrotask(() => {
			onValueChange(id);
			onPromptVersionChange?.(versionId);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isLoading]);

	// Bind mutation
	const bindMutation = useMutation({
		mutationFn: async () => {
			if (!selectedPrompt?.latestVersion) {
				throw new Error("No version available for selected prompt");
			}

			if (!documentType) {
				throw new Error("Document type is required for binding");
			}

			return await orpcClient.prompts.bind.set({
				targetType: "AGENT",
				targetKey: agentName,
				documentType, // Required: Each binding must specify a document type
				storyKind,
				scope: selectedScope === "PROJECT" ? "ORG" : selectedScope,
				organizationId:
					selectedScope === "USER" ? null : (organizationId ?? null),
				projectId: selectedScope === "PROJECT" ? projectId : null,
				promptVersionId: selectedPrompt.latestVersion.id,
				isDefault: true, // "Bind as Default" always sets as default
			});
		},
		onSuccess: () => {
			toast.success("Prompt bound as default successfully");
			setBindDialogOpen(false);
			// Invalidate queries to refresh binding status and selector
			queryClient.invalidateQueries({ queryKey: ["prompts"] });
		},
		onError: (error) => {
			toast.error("Failed to bind prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleBindClick = () => {
		if (!effectiveValue) {
			toast.error("Please select a prompt first");
			return;
		}
		setBindDialogOpen(true);
	};

	const handleViewPrompt = useCallback(() => {
		if (selectedPrompt) {
			setPreviewPromptId(selectedPrompt.id);
			setPreviewOpen(true);
		}
	}, [selectedPrompt]);

	const handlePromptUpdated = useCallback(
		(newVersionId?: string) => {
			queryClient.invalidateQueries({ queryKey: ["prompts"] });
			if (newVersionId) {
				onPromptVersionChange?.(newVersionId);
			}
		},
		[queryClient, onPromptVersionChange],
	);

	// Build manage prompts link with document type filter
	const managePromptsUrl = documentType
		? `${basePath}/prompts?type=${documentType}`
		: `${basePath}/prompts`;

	// FR14: "anywhere a user selects a prompt" includes here — this selector is
	// the one people meet during document generation. The link lands on this
	// exact action's catalog entry, where every prompt bound to it is listed
	// with its tier, rather than on the library filtered by document type.
	const catalogActionUrl = documentType
		? `${basePath}/prompts/catalog?action=${encodeURIComponent(
				promptActionId(agentName, documentType, storyKind ?? null),
			)}`
		: null;

	// Always pass a string to keep Radix Select in controlled mode.
	// An empty string means "no selection" without switching to uncontrolled.
	const selectValue =
		effectiveValue && prompts.some((p) => p.id === effectiveValue)
			? effectiveValue
			: "";

	return (
		<TooltipProvider>
			<div className="flex items-center gap-2 w-full min-w-0">
				<Select
					value={selectValue}
					onValueChange={(val) => {
						onValueChange(val);
						// Also notify parent of the prompt version ID for attribution
						if (onPromptVersionChange) {
							const prompt = prompts.find((p) => p.id === val);
							onPromptVersionChange(prompt?.latestVersion?.id);
						}
					}}
					disabled={disabled || isLoading}
				>
					<SelectTrigger
						id={triggerId}
						// The fallback yields to a caller-supplied association.
						// `aria-label` outranks a `<label for>`, so applying it
						// unconditionally would make the generic name win over the
						// visible one the caller wired up — the announced text and
						// the text on screen would differ, which is worse than the
						// gap this closes.
						aria-label={
							ariaLabel ??
							(triggerId ? undefined : t("selectPrompt"))
						}
						className={
							compact
								? "!h-8 text-xs w-full max-w-md min-w-0 pr-3"
								: "w-full max-w-md min-w-0"
						}
					>
						<div
							className={
								compact
									? "flex items-center gap-1.5 truncate mr-2"
									: "flex items-center gap-2 truncate"
							}
						>
							<Sparkles
								className={
									compact
										? "size-3 text-muted-foreground shrink-0"
										: "h-4 w-4 text-muted-foreground shrink-0"
								}
							/>
							<span className="truncate">
								{selectedPrompt ? (
									<>
										{selectedPrompt.name}
										{selectedPrompt.isDefault && (
											<Badge
												variant="secondary"
												className={
													compact
														? "ml-2 text-[10px] h-4 px-1 py-0"
														: "ml-2 text-xs"
												}
											>
												Default
											</Badge>
										)}
									</>
								) : (
									placeholder
								)}
							</span>
						</div>
					</SelectTrigger>
					<SelectContent className="max-w-lg">
						{/* System prompts */}
						{systemPrompts.length > 0 && (
							<SelectGroup>
								<SelectLabel>System Prompts</SelectLabel>
								{systemPrompts.map((prompt) => (
									<SelectItem
										key={prompt.id}
										value={prompt.id}
									>
										<div className="flex flex-col gap-0.5 min-w-0">
											<div className="flex items-center gap-1.5 min-w-0">
												{prompt.isDefault && (
													<CheckCircle2 className="h-3 w-3 text-success shrink-0" />
												)}
												{prompt.forkedFrom && (
													<GitFork className="h-3 w-3 text-muted-foreground shrink-0" />
												)}
												<span className="truncate min-w-0 flex-1">
													{prompt.name}
												</span>
												{prompt.isDefault && (
													<Badge
														variant="secondary"
														className="ml-auto text-xs shrink-0"
													>
														Default
													</Badge>
												)}
											</div>
											{prompt.contentSnippet && (
												<p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 break-words">
													{prompt.contentSnippet}
												</p>
											)}
										</div>
									</SelectItem>
								))}
							</SelectGroup>
						)}

						{/* Organization prompts */}
						{orgPrompts.length > 0 && (
							<SelectGroup>
								<SelectLabel>Organization Prompts</SelectLabel>
								{orgPrompts.map((prompt) => (
									<SelectItem
										key={prompt.id}
										value={prompt.id}
									>
										<div className="flex flex-col gap-0.5 min-w-0">
											<div className="flex items-center gap-1.5 min-w-0">
												{prompt.isDefault && (
													<CheckCircle2 className="h-3 w-3 text-success shrink-0" />
												)}
												{prompt.forkedFrom && (
													<GitFork className="h-3 w-3 text-muted-foreground shrink-0" />
												)}
												<span className="truncate min-w-0 flex-1">
													{prompt.name}
												</span>
												{prompt.isDefault && (
													<Badge
														variant="secondary"
														className="ml-auto text-xs shrink-0"
													>
														Default
													</Badge>
												)}
											</div>
											{prompt.contentSnippet && (
												<p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 break-words">
													{prompt.contentSnippet}
												</p>
											)}
										</div>
									</SelectItem>
								))}
							</SelectGroup>
						)}

						{/* User prompts */}
						{userPrompts.length > 0 && (
							<SelectGroup>
								<SelectLabel>My Prompts</SelectLabel>
								{userPrompts.map((prompt) => (
									<SelectItem
										key={prompt.id}
										value={prompt.id}
									>
										<div className="flex flex-col gap-0.5 min-w-0">
											<div className="flex items-center gap-1.5 min-w-0">
												{prompt.isDefault && (
													<CheckCircle2 className="h-3 w-3 text-success shrink-0" />
												)}
												{prompt.forkedFrom && (
													<GitFork className="h-3 w-3 text-muted-foreground shrink-0" />
												)}
												<span className="truncate min-w-0 flex-1">
													{prompt.name}
												</span>
												{prompt.isDefault && (
													<Badge
														variant="secondary"
														className="ml-auto text-xs shrink-0"
													>
														Default
													</Badge>
												)}
											</div>
											{prompt.contentSnippet && (
												<p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 break-words">
													{prompt.contentSnippet}
												</p>
											)}
										</div>
									</SelectItem>
								))}
							</SelectGroup>
						)}

						{/* Empty state */}
						{prompts.length === 0 && !isLoading && (
							<div className="px-2 py-6 text-center text-sm text-muted-foreground">
								No custom prompts available
							</div>
						)}
					</SelectContent>
				</Select>

				{/* View Prompt button - shows when a prompt is selected */}
				{selectedPrompt && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8 shrink-0"
								onClick={handleViewPrompt}
								disabled={disabled}
								aria-label={t("viewPrompt")}
							>
								<EyeIcon
									className={compact ? "size-3" : "h-4 w-4"}
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent
							collisionBoundary={
								tooltipCollisionBoundaryRef?.current ??
								undefined
							}
							collisionPadding={8}
						>
							{t("viewPrompt")}
						</TooltipContent>
					</Tooltip>
				)}

				{/* FR14: reach this action's catalog entry from where the
				    prompt is actually being chosen. */}
				{catalogActionUrl && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8 shrink-0"
								disabled={disabled}
								asChild
							>
								<Link
									href={catalogActionUrl}
									aria-label="View in Catalog"
								>
									<LibraryIcon
										className={
											compact ? "size-3" : "h-4 w-4"
										}
									/>
								</Link>
							</Button>
						</TooltipTrigger>
						<TooltipContent
							collisionBoundary={
								tooltipCollisionBoundaryRef?.current ??
								undefined
							}
							collisionPadding={8}
						>
							View in Catalog
						</TooltipContent>
					</Tooltip>
				)}

				{/* Manage Prompts link — suppressed when the page chrome owns
				  this control (see hideManagePromptsAction). */}
				{!hideManagePromptsAction && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-8 w-8 shrink-0"
								asChild
							>
								<Link
									href={managePromptsUrl}
									aria-label={t("managePrompts")}
								>
									<SettingsIcon
										className={
											compact ? "size-3" : "h-4 w-4"
										}
									/>
								</Link>
							</Button>
						</TooltipTrigger>
						<TooltipContent
							collisionBoundary={
								tooltipCollisionBoundaryRef?.current ??
								undefined
							}
							collisionPadding={8}
						>
							{t("managePrompts")}
						</TooltipContent>
					</Tooltip>
				)}

				{/* Bind as Default Button */}
				{showBindAction && effectiveValue && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={handleBindClick}
								disabled={disabled || bindMutation.isPending}
								className={
									compact
										? "shrink-0 h-8 gap-1.5 text-xs"
										: "shrink-0"
								}
								aria-label={
									selectedPrompt?.isBound
										? "Update Binding"
										: "Bind as Default"
								}
							>
								<Link2Icon
									className={
										compact
											? "size-3 md:mr-2"
											: "h-4 w-4 md:mr-2"
									}
								/>
								<span className="hidden md:inline">
									{selectedPrompt?.isBound
										? "Update Binding"
										: "Bind as Default"}
								</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent
							collisionBoundary={
								tooltipCollisionBoundaryRef?.current ??
								undefined
							}
							collisionPadding={8}
						>
							{selectedPrompt?.isBound
								? t("updateBinding")
								: t("bindAsDefault")}
						</TooltipContent>
					</Tooltip>
				)}

				{/* Bind Dialog */}
				<Dialog open={bindDialogOpen} onOpenChange={setBindDialogOpen}>
					<DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Bind Prompt as Default</DialogTitle>
							<DialogDescription>
								Set "{selectedPrompt?.name}" as the default
								prompt for this agent and document type.
							</DialogDescription>
						</DialogHeader>

						<div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-4 pr-1">
							{/* Binding Details */}
							<div className="space-y-2 p-3 bg-muted/50 rounded-md border">
								<div className="grid grid-cols-2 gap-2 text-sm">
									<div>
										<p className="text-muted-foreground text-xs">
											Agent
										</p>
										<p className="font-medium">
											{agentName.replace(/_/g, " ")}
										</p>
									</div>
									<div>
										<p className="text-muted-foreground text-xs">
											Document Type
										</p>
										<p className="font-medium">
											{documentType
												? documentType.replace(
														/_/g,
														" ",
													)
												: "All Types"}
										</p>
									</div>
								</div>
							</div>

							{/* Selected Prompt Info */}
							{selectedPrompt && (
								<div className="flex items-center gap-2 p-3 bg-muted rounded-md">
									<div className="flex-1">
										<p className="font-medium text-sm">
											{selectedPrompt.name}
										</p>
										<div className="flex items-center gap-2 mt-1">
											<Badge
												variant="outline"
												className="text-xs"
											>
												{selectedPrompt.scope}
											</Badge>
											{selectedPrompt.isBound && (
												<Badge
													variant="default"
													className="text-xs"
												>
													<CheckCircle2 className="mr-1 h-3 w-3" />
													Currently Bound
												</Badge>
											)}
										</div>
									</div>
								</div>
							)}

							{/* Scope Selection */}
							<div className="space-y-2">
								<Label>Binding Scope</Label>
								<ScopeSelect
									value={selectedScope}
									onValueChange={(val) =>
										setSelectedScope(
											val as "USER" | "ORG" | "PROJECT",
										)
									}
								>
									<ScopeSelectTrigger>
										<ScopeSelectValue />
									</ScopeSelectTrigger>
									<ScopeSelectContent>
										<ScopeSelectItem value="USER">
											Personal (just for me)
										</ScopeSelectItem>
										{isOrgContext &&
											isOrganizationAdmin &&
											projectId && (
												<ScopeSelectItem value="PROJECT">
													Project (this project only)
												</ScopeSelectItem>
											)}
										{isOrgContext &&
											isOrganizationAdmin && (
												<ScopeSelectItem value="ORG">
													Organization (for all
													members)
												</ScopeSelectItem>
											)}
									</ScopeSelectContent>
								</ScopeSelect>
								<p className="text-muted-foreground text-xs">
									{selectedScope === "USER"
										? "This binding will only affect your documents"
										: selectedScope === "PROJECT"
											? "This binding becomes the default inside this project, overriding the organization's"
											: "This binding will affect all organization members"}
								</p>
							</div>
						</div>

						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => setBindDialogOpen(false)}
							>
								Cancel
							</Button>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => bindMutation.mutate()}
										disabled={bindMutation.isPending}
									>
										{bindMutation.isPending && (
											<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										)}
										Bind as Default
									</Button>
								</TooltipTrigger>
								<TooltipContent
									collisionBoundary={
										tooltipCollisionBoundaryRef?.current ??
										undefined
									}
									collisionPadding={8}
								>
									{t("bindAsDefault")}
								</TooltipContent>
							</Tooltip>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{/* Prompt Preview Sheet */}
				{previewPromptId && (
					<PromptPreviewSheet
						open={previewOpen}
						onOpenChange={setPreviewOpen}
						promptId={previewPromptId}
						promptScope={selectedPrompt?.scope}
						onPromptUpdated={handlePromptUpdated}
					/>
				)}
			</div>
		</TooltipProvider>
	);
}
