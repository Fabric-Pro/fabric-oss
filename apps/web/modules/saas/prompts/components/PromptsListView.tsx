"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	CopyIcon,
	EditIcon,
	EyeIcon,
	LibraryIcon,
	Link2Icon,
	MoreVerticalIcon,
	TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PromptDefaultBadge } from "./PromptDefaultBadge";
import { PromptFormatBadge } from "./PromptFormatBadge";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { PromptScopeBadge } from "./PromptScopeBadge";
import { PromptTag } from "./PromptTag";
import { SetAsDefaultDialog } from "./SetAsDefaultDialog";

type Prompt = {
	id: string;
	name: string;
	description: string | null;
	scope: "SYSTEM" | "ORG" | "USER";
	format:
		| "PLAIN_TEXT"
		| "MARKDOWN"
		| "HANDLEBARS"
		| "MUSTACHE"
		| "LIQUID"
		| "JINJA2";
	category: string | null;
	tags: string[];
	isPublic: boolean;
	usageCount: number;
	lastUsedAt: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	versions?: Array<{ id: string; version: number; content: string }>;
	isDefault?: boolean;
	isBound?: boolean;
	/** Tier the effective default came from; null when this is not the winner. */
	defaultScope?: "SYSTEM" | "ORG" | "USER" | null;
};

type Props = {
	prompts: Prompt[];
	onUpdate: () => void;
	/** Active document type filter from parent, used for "Set as Default" pre-selection */
	documentTypeFilter?: string;
};

export function PromptsListView({
	prompts,
	onUpdate,
	documentTypeFilter,
}: Props) {
	return (
		<TooltipProvider>
			<div className="space-y-3">
				{prompts.map((prompt) => (
					<PromptListItem
						key={prompt.id}
						prompt={prompt}
						onUpdate={onUpdate}
						documentTypeFilter={documentTypeFilter}
					/>
				))}
			</div>
		</TooltipProvider>
	);
}

function PromptListItem({
	prompt,
	onUpdate,
	documentTypeFilter,
}: {
	prompt: Prompt;
	onUpdate: () => void;
	documentTypeFilter?: string;
}) {
	const router = useRouter();
	const { confirm } = useConfirmationAlert();
	const { basePath: orgBasePath } = useOrganizationContext();
	const [setDefaultOpen, setSetDefaultOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);

	// Organization-aware base path for prompts
	const basePath = `${orgBasePath}/prompts`;
	const isEditable = prompt.scope !== "SYSTEM";
	const latestVersionId = prompt.versions?.[0]?.id;

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.prompts.delete({ id: prompt.id });
		},
		onSuccess: () => {
			toast.success("Prompt deleted successfully");
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to delete prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleDelete = () => {
		confirm({
			title: "Delete Prompt",
			message: `Are you sure you want to delete "${prompt.name}"? This action cannot be undone.`,
			confirmLabel: "Delete",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => deleteMutation.mutate(),
		});
	};

	const handleDuplicate = () => {
		router.push(`${basePath}/new?duplicateFrom=${prompt.id}`);
	};

	return (
		<Card
			className="hover:shadow-md transition-all group cursor-pointer"
			onClick={() => router.push(`${basePath}/${prompt.id}`)}
		>
			<div className="w-full p-4">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-3 mb-2 flex-wrap">
							<Tooltip delayDuration={500}>
								<TooltipTrigger asChild>
									<span className="inline-block">
										<h3 className="font-semibold text-lg line-clamp-1">
											{prompt.name}
										</h3>
									</span>
								</TooltipTrigger>
								<TooltipContent>
									<p>{prompt.name}</p>
								</TooltipContent>
							</Tooltip>
							<PromptDefaultBadge
								isDefault={prompt.isDefault}
								isBound={prompt.isBound}
								defaultScope={prompt.defaultScope}
								className="text-xs"
							/>
							<PromptScopeBadge scope={prompt.scope} />
							<PromptFormatBadge format={prompt.format} />
							{prompt.isPublic && (
								<Badge variant="outline">
									<EyeIcon className="mr-1 size-3" />
									Public
								</Badge>
							)}
						</div>

						{/* Description */}
						{prompt.description && (
							<p className="text-sm text-muted-foreground line-clamp-1 mb-2">
								{prompt.description}
							</p>
						)}

						<div className="flex items-center gap-6 text-sm text-muted-foreground flex-wrap">
							{/* Category */}
							{prompt.category && (
								<div className="flex items-center gap-2">
									<Badge variant="secondary">
										{prompt.category}
									</Badge>
								</div>
							)}

							{/* Tags */}
							{prompt.tags && prompt.tags.length > 0 && (
								<div className="flex items-center gap-2 flex-wrap">
									{prompt.tags.slice(0, 3).map((tag) => (
										<PromptTag key={tag}>{tag}</PromptTag>
									))}
									{prompt.tags.length > 3 && (
										<Badge
											variant="outline"
											className="text-xs"
										>
											+{prompt.tags.length - 3}
										</Badge>
									)}
								</div>
							)}

							{/* Stats */}
							<div className="text-xs text-muted-foreground">
								Used {prompt.usageCount} times
							</div>

							<div className="text-xs text-muted-foreground">
								Updated{" "}
								{formatDistanceToNow(
									new Date(prompt.updatedAt),
								)}{" "}
								ago
							</div>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<DropdownMenu>
							<DropdownMenuTrigger
								asChild
								onClick={(e) => e.stopPropagation()}
							>
								<Button
									variant="ghost"
									size="sm"
									className="md:opacity-0 md:group-hover:opacity-100 transition-opacity focus:opacity-100"
								>
									<MoreVerticalIcon className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setPreviewOpen(true);
									}}
								>
									<EyeIcon className="mr-2 h-4 w-4" />
									Preview
								</DropdownMenuItem>
								{isEditable && (
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											router.push(
												`${basePath}/${prompt.id}`,
											);
										}}
									>
										<EditIcon className="mr-2 h-4 w-4" />
										Edit
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										handleDuplicate();
									}}
								>
									<CopyIcon className="mr-2 h-4 w-4" />
									Duplicate
								</DropdownMenuItem>
								{latestVersionId && (
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											setSetDefaultOpen(true);
										}}
									>
										<Link2Icon className="mr-2 h-4 w-4" />
										Set as Default
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										router.push(
											`${basePath}/catalog?prompt=${prompt.id}`,
										);
									}}
								>
									<LibraryIcon className="mr-2 h-4 w-4" />
									View in Catalog
								</DropdownMenuItem>
								{isEditable && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												handleDelete();
											}}
											className="text-destructive"
										>
											<TrashIcon className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
			</div>

			{/* Set as Default Dialog */}
			{latestVersionId && (
				<SetAsDefaultDialog
					open={setDefaultOpen}
					onOpenChange={setSetDefaultOpen}
					promptName={prompt.name}
					promptVersionId={latestVersionId}
					promptId={prompt.id}
					initialDocumentType={documentTypeFilter}
					onSuccess={onUpdate}
				/>
			)}

			{/* Prompt Preview Sheet */}
			<PromptPreviewSheet
				open={previewOpen}
				onOpenChange={setPreviewOpen}
				promptId={prompt.id}
				onPromptUpdated={onUpdate}
			/>
		</Card>
	);
}
