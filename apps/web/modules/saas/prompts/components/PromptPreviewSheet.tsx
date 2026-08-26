"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CopyIcon,
	EditIcon,
	ExternalLinkIcon,
	GitForkIcon,
	Loader2Icon,
	SaveIcon,
	XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PromptScopeBadge } from "./PromptScopeBadge";
import { PromptTag } from "./PromptTag";

interface PromptPreviewSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	promptId: string;
	/** Scope of the prompt being previewed — used to bypass org filter for USER prompts */
	promptScope?: string;
	/** If true, open in edit mode directly */
	initialEditMode?: boolean;
	/** Called after a successful edit/version creation, with the new version ID */
	onPromptUpdated?: (newVersionId?: string) => void;
}

export function PromptPreviewSheet({
	open,
	onOpenChange,
	promptId,
	promptScope,
	initialEditMode = false,
	onPromptUpdated,
}: PromptPreviewSheetProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const { organizationId, basePath } = useOrganizationContext();
	const [isEditing, setIsEditing] = useState(initialEditMode);
	const [editContent, setEditContent] = useState("");

	// Fetch full prompt details
	// USER-scoped prompts are not visible when organizationId is set,
	// so pass null to ensure the backend includes them.
	const queryOrganizationId = promptScope === "USER" ? null : organizationId;
	const { data: prompt, isLoading } = useQuery({
		...orpc.prompts.get.byId.queryOptions({
			input: {
				id: promptId,
				organizationId: queryOrganizationId,
			},
		}),
		enabled: open && !!promptId,
	});

	const latestVersion = prompt?.versions?.[0];
	const content = latestVersion?.content ?? "";
	const isSystemPrompt = prompt?.scope === "SYSTEM";
	const titleText = isLoading ? "Loading..." : (prompt?.name ?? "Prompt");

	// Reset edit state when prompt changes or sheet opens
	useEffect(() => {
		if (open && content) {
			setEditContent(content);
			setIsEditing(initialEditMode);
		}
	}, [open, content, initialEditMode]);

	// Create new version mutation (for USER/ORG prompts)
	const createVersionMutation = useMutation({
		mutationFn: async (newContent: string) => {
			return await orpcClient.prompts.version.create({
				id: promptId,
				content: newContent,
			});
		},
		onSuccess: (version) => {
			toast.success("Prompt updated with new version");
			setIsEditing(false);
			queryClient.invalidateQueries({ queryKey: ["prompts"] });
			onPromptUpdated?.(version?.id);
		},
		onError: (error) => {
			toast.error("Failed to save prompt version", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Fork mutation (for SYSTEM prompts)
	const forkMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.prompts.fork.fork({
				sourcePromptId: promptId,
				targetScope: organizationId ? "ORG" : "USER",
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: (forkedPrompt) => {
			toast.success("Prompt forked successfully");
			queryClient.invalidateQueries({ queryKey: ["prompts"] });
			onPromptUpdated?.();
			onOpenChange(false);
			// Navigate to the forked prompt for editing
			if (forkedPrompt?.id) {
				router.push(`${basePath}/prompts/${forkedPrompt.id}`);
			}
		},
		onError: (error) => {
			toast.error("Failed to fork prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleSave = useCallback(() => {
		if (editContent.trim() === content.trim()) {
			setIsEditing(false);
			return;
		}
		createVersionMutation.mutate(editContent);
	}, [editContent, content, createVersionMutation]);

	const handleEditClick = useCallback(() => {
		if (isSystemPrompt) {
			// System prompts must be forked before editing
			forkMutation.mutate();
		} else {
			setIsEditing(true);
		}
	}, [isSystemPrompt, forkMutation]);

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(content);
		toast.success("Copied to clipboard");
	}, [content]);

	const handleOpenFullPage = useCallback(() => {
		onOpenChange(false);
		router.push(`${basePath}/prompts/${promptId}`);
	}, [basePath, promptId, router, onOpenChange]);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[500px] sm:w-[600px] flex flex-col">
				<SheetHeader className="shrink-0">
					<div className="flex items-center gap-2">
						<SheetTitle className="min-w-0 flex-1">
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="block truncate">
										{titleText}
									</span>
								</TooltipTrigger>
								<TooltipContent className="max-w-sm break-words">
									{titleText}
								</TooltipContent>
							</Tooltip>
						</SheetTitle>
						{prompt?.scope && (
							<PromptScopeBadge scope={prompt.scope} />
						)}
					</div>
					{prompt?.description && (
						<Tooltip>
							<TooltipTrigger asChild>
								<SheetDescription className="line-clamp-2">
									{prompt.description}
								</SheetDescription>
							</TooltipTrigger>
							<TooltipContent className="max-w-sm break-words">
								{prompt.description}
							</TooltipContent>
						</Tooltip>
					)}
				</SheetHeader>

				{isLoading ? (
					<div className="flex items-center justify-center py-12">
						<Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				) : (
					<div className="flex flex-col flex-1 mt-4 min-h-0">
						{/* Metadata row */}
						<div className="flex shrink-0 items-center gap-2 mb-3 flex-wrap">
							{latestVersion && (
								<Badge variant="outline" className="text-xs">
									v{latestVersion.version}
								</Badge>
							)}
							{prompt?.format &&
								prompt.format !== "PLAIN_TEXT" && (
									<Badge
										variant="secondary"
										className="text-xs"
									>
										{prompt.format
											.replace(/_/g, " ")
											.toLowerCase()}
									</Badge>
								)}
							{prompt?.category && (
								<Badge variant="secondary" className="text-xs">
									{prompt.category}
								</Badge>
							)}
							{prompt?.tags?.map((tag: string) => (
								<PromptTag key={tag}>{tag}</PromptTag>
							))}
						</div>

						{/* Content area */}
						<div className="flex-1 min-h-0">
							{isEditing ? (
								<Textarea
									value={editContent}
									onChange={(e) =>
										setEditContent(e.target.value)
									}
									className="h-full min-h-[300px] font-mono text-sm resize-none"
									placeholder="Enter prompt content..."
								/>
							) : (
								<ScrollArea className="h-full">
									<pre className="text-sm font-mono whitespace-pre-wrap break-words p-4 bg-muted rounded-lg">
										{content || "No content available"}
									</pre>
								</ScrollArea>
							)}
						</div>

						{/* Action buttons */}
						<div className="flex shrink-0 flex-wrap items-center gap-2 mt-4 pt-4 border-t">
							{isEditing ? (
								<>
									<Button
										onClick={handleSave}
										disabled={
											createVersionMutation.isPending
										}
										size="sm"
									>
										{createVersionMutation.isPending ? (
											<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										) : (
											<SaveIcon className="mr-2 h-4 w-4" />
										)}
										Save as New Version
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											setEditContent(content);
											setIsEditing(false);
										}}
									>
										<XIcon className="mr-2 h-4 w-4" />
										Cancel
									</Button>
								</>
							) : (
								<>
									<Button
										variant="outline"
										size="sm"
										onClick={handleEditClick}
										disabled={forkMutation.isPending}
									>
										{forkMutation.isPending ? (
											<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										) : isSystemPrompt ? (
											<GitForkIcon className="mr-2 h-4 w-4" />
										) : (
											<EditIcon className="mr-2 h-4 w-4" />
										)}
										{isSystemPrompt
											? "Fork & Edit"
											: "Edit"}
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={handleCopy}
									>
										<CopyIcon className="mr-2 h-4 w-4" />
										Copy
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={handleOpenFullPage}
									>
										<ExternalLinkIcon className="mr-2 h-4 w-4" />
										Open Full Page
									</Button>
								</>
							)}
						</div>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}
