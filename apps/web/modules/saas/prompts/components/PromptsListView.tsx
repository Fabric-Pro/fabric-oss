"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
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
import { usePromptDeletion } from "../hooks/use-prompt-deletion";
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
	/**
	 * Who owns the prompt. Required, not optional: the delete predicate cannot
	 * judge an ORG or USER prompt without them, and defaulting a missing owner
	 * to null would quietly withhold Delete on personal prompts that offer it
	 * today. `prompts.list` returns whole prompt rows, so both are already on
	 * the wire — this only names them.
	 */
	organizationId: string | null;
	userId: string | null;
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
};

export function PromptsListView({ prompts, onUpdate }: Props) {
	return (
		<TooltipProvider>
			<div className="space-y-3">
				{prompts.map((prompt) => (
					<PromptListItem
						key={prompt.id}
						prompt={prompt}
						onUpdate={onUpdate}
					/>
				))}
			</div>
		</TooltipProvider>
	);
}

function PromptListItem({
	prompt,
	onUpdate,
}: {
	prompt: Prompt;
	onUpdate: () => void;
}) {
	const router = useRouter();
	const { basePath: orgBasePath } = useOrganizationContext();
	const [setDefaultOpen, setSetDefaultOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);

	// Organization-aware base path for prompts
	const basePath = `${orgBasePath}/prompts`;
	// Edit and Delete were one question with one answer, and they are not the
	// same question. `isEditable` stays exactly what it was — repointing it at
	// the delete predicate would quietly turn Edit on for SYSTEM prompts, which
	// R3 forbids. Delete gets its own answer, from the shared hook every
	// listing surface asks (Fizzy #2328).
	const isEditable = prompt.scope !== "SYSTEM";
	const latestVersionId = prompt.versions?.[0]?.id;

	const deletion = usePromptDeletion({ prompt, onDeleted: onUpdate });

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
							{/* Stays visible while it is busy: the menu has
							    already closed, so a trigger that faded out
							    would leave the wait with no on-screen home. */}
							<DropdownMenuTrigger
								asChild
								onClick={(e) => e.stopPropagation()}
							>
								<Button
									variant="ghost"
									size="sm"
									{...deletion.triggerProps}
									className={`transition-opacity focus:opacity-100 ${
										deletion.isPreparing
											? "opacity-100"
											: "md:opacity-0 md:group-hover:opacity-100"
									}`}
								>
									{deletion.isPreparing ? (
										<Spinner className="motion-reduce:animate-none" />
									) : (
										<MoreVerticalIcon className="h-4 w-4" />
									)}
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
								{deletion.canDelete && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												deletion.requestDelete();
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
						{deletion.announcement}
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
