"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { TooltipProvider } from "@ui/components/tooltip";
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
			<div className="overflow-hidden rounded-md border border-border">
				<Table aria-label="Prompts" className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>Name & purpose</TableHead>
							<TableHead className="hidden w-36 md:table-cell">
								Access
							</TableHead>
							<TableHead className="hidden w-32 lg:table-cell">
								Format
							</TableHead>
							<TableHead className="hidden w-40 md:table-cell">
								Updated
							</TableHead>
							<TableHead className="w-14">
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{prompts.map((prompt) => (
							<PromptListItem
								key={prompt.id}
								prompt={prompt}
								onUpdate={onUpdate}
							/>
						))}
					</TableBody>
				</Table>
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
	const { basePath: orgBasePath, userRole } = useOrganizationContext();
	const [setDefaultOpen, setSetDefaultOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);

	// Organization-aware base path for prompts
	const basePath = `${orgBasePath}/prompts`;
	// Edit and Delete were one question with one answer, and they are not the
	// same question. `isEditable` stays exactly what it was — repointing it at
	// the delete predicate would quietly turn Edit on for SYSTEM prompts, which
	// R3 forbids. Delete gets its own answer, from the shared hook every
	// listing surface asks (Fizzy #2328).
	const isEditable =
		prompt.scope !== "SYSTEM" &&
		(prompt.scope !== "ORG" ||
			userRole === "owner" ||
			userRole === "admin");
	const latestVersionId = prompt.versions?.[0]?.id;

	const deletion = usePromptDeletion({ prompt, onDeleted: onUpdate });

	const handleDuplicate = () => {
		router.push(`${basePath}/new?duplicateFrom=${prompt.id}`);
	};

	return (
		<>
			<TableRow className="group">
				<TableCell className="py-4">
					<button
						type="button"
						onClick={() => setPreviewOpen(true)}
						className="max-w-full rounded text-left text-sm font-semibold leading-6 hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="line-clamp-2 break-words">
							{prompt.name}
						</span>
					</button>
					{prompt.description && (
						<p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
							{prompt.description}
						</p>
					)}
					<PromptDefaultBadge
						isDefault={prompt.isDefault}
						isBound={prompt.isBound}
						defaultScope={prompt.defaultScope}
						className="mt-1 text-xs"
					/>
				</TableCell>
				<TableCell className="hidden md:table-cell">
					<PromptScopeBadge scope={prompt.scope} />
				</TableCell>
				<TableCell className="hidden lg:table-cell">
					<PromptFormatBadge format={prompt.format} />
				</TableCell>
				<TableCell className="hidden text-xs text-muted-foreground md:table-cell">
					{formatDistanceToNow(new Date(prompt.updatedAt), {
						addSuffix: true,
					})}
				</TableCell>
				<TableCell>
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
										: "opacity-100"
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
											`${basePath}/${prompt.id}?edit=1&returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`,
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
				</TableCell>
			</TableRow>

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
				fullPageEdit
				promptId={prompt.id}
				onPromptUpdated={onUpdate}
			/>
		</>
	);
}
