"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
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
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	Copy,
	CopyIcon,
	EditIcon,
	ImageIcon,
	LibraryIcon,
	Link2Icon,
	Link2OffIcon,
	Lock,
	MoreVerticalIcon,
	Play,
	TrashIcon,
	Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePromptDeletion } from "../hooks/use-prompt-deletion";
import { hasVariables } from "../lib/variable-detection";
import { PromptDefaultBadge } from "./PromptDefaultBadge";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { PromptTag } from "./PromptTag";
import { SetAsDefaultDialog } from "./SetAsDefaultDialog";
import { UpvoteButton } from "./UpvoteButton";

// Get display name for format
function getFormatDisplayName(format: string): string {
	const formatNames: Record<string, string> = {
		PLAIN_TEXT: "Plain",
		MARKDOWN: "MD",
		HANDLEBARS: "HBS",
		MUSTACHE: "Mustache",
		LIQUID: "Liquid",
		JINJA2: "Jinja2",
	};
	return formatNames[format] || format;
}

type PromptType = "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "STRUCTURED" | "SKILL";

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
	promptType?: PromptType;
	structuredFormat?: string | null;
	category: string | null;
	tags: string[];
	heroEmojis?: string[];
	heroImageUrl?: string | null;
	mediaUrl?: string | null;
	isPublic: boolean;
	usageCount: number;
	voteCount?: number;
	lastUsedAt: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	createdBy?: string;
	versions?: Array<{ id: string; version: number; content: string }>;
	forkedFrom?: {
		id: string;
		key: string;
		name: string;
		scope: "SYSTEM" | "ORG" | "USER";
	} | null;
	author?: {
		id: string;
		name: string | null;
		username?: string;
		avatar?: string | null;
	};
	isDefault?: boolean;
	isBound?: boolean;
	/** Tier the effective default came from; null when this is not the winner. */
	defaultScope?: "SYSTEM" | "ORG" | "USER" | null;
};

type Props = {
	prompt: Prompt;
	onUpdate?: () => void;
	showPinButton?: boolean;
	isPinned?: boolean;
	/** Story kind context when the card renders for one work-item kind, so
	 *  re-binding from this card lands in the right kind bucket instead of
	 *  NULL. */
	storyKindContext?: import("@repo/database").StoryKind;
	/** The binding this card is standing in for, when it is rendered as one.
	 *  Present only on surfaces that list bindings (the stage defaults panels);
	 *  the library grid has no binding context and offers no clear action. */
	binding?: {
		targetKey: string;
		documentType: string;
		scope: "SYSTEM" | "ORG" | "USER";
	};
};

// Render content with variable highlighting
function renderContentWithVariables(content: string): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const regex = /\$\{([^:}]+)(?::([^}]*))?\}/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	let keyIndex = 0;

	while (
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
		(match = regex.exec(content)) !== null
	) {
		if (match.index > lastIndex) {
			parts.push(
				<span key={keyIndex++}>
					{content.slice(lastIndex, match.index)}
				</span>,
			);
		}

		const name = match[1].trim();
		parts.push(
			<span
				key={keyIndex++}
				className="bg-primary/10 text-primary px-0.5 rounded text-[10px]"
			>
				{name}
			</span>,
		);

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < content.length) {
		parts.push(<span key={keyIndex++}>{content.slice(lastIndex)}</span>);
	}

	return parts;
}

export function PromptCard({
	prompt,
	onUpdate,
	showPinButton: _showPinButton = false,
	isPinned: _isPinned = false,
	storyKindContext,
	binding,
}: Props) {
	const router = useRouter();
	const tTooltips = useTranslations("tooltips.common");
	const { confirm } = useConfirmationAlert();
	const { basePath, organizationId } = useOrganizationContext();
	const [setDefaultOpen, setSetDefaultOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);

	// Edit and Delete were one question with one answer, and they are not the
	// same question. `isEditable` stays exactly what it was — repointing it at
	// the delete predicate would quietly turn Edit on for SYSTEM prompts, which
	// R3 forbids. Delete gets its own answer, from the shared hook every
	// listing surface asks (Fizzy #2328).
	const isEditable = prompt.scope !== "SYSTEM";
	const latestVersionId = prompt.versions?.[0]?.id;

	const deletion = usePromptDeletion({ prompt, onDeleted: onUpdate });

	const handleDuplicate = () => {
		router.push(`${basePath}/prompts/new?duplicateFrom=${prompt.id}`);
	};

	// Only an override can be cleared. A SYSTEM binding is the baseline the
	// other tiers fall back TO, so clearing it from here would leave the action
	// with no prompt at all rather than reverting it to something.
	const clearableBinding =
		binding && binding.scope !== "SYSTEM" ? binding : null;

	const clearMutation = useMutation({
		mutationFn: async () => {
			if (!clearableBinding) {
				throw new Error("No override to clear");
			}
			return await orpcClient.prompts.bind.clear({
				targetType: "AGENT",
				targetKey: clearableBinding.targetKey,
				documentType: clearableBinding.documentType,
				storyKind: storyKindContext ?? null,
				scope: clearableBinding.scope,
				organizationId:
					clearableBinding.scope === "ORG"
						? (organizationId ?? null)
						: null,
			});
		},
		onSuccess: (result: { cleared?: boolean }) => {
			toast.success(
				result?.cleared
					? "Override cleared — this action now uses the next level's default"
					: "There was no override to clear",
			);
			onUpdate?.();
		},
		onError: (error) => {
			toast.error("Failed to clear the override", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleClearOverride = () => {
		confirm({
			title: "Clear Default Override",
			message:
				clearableBinding?.scope === "ORG"
					? "This action will fall back to the universal default for everyone in the organization who has not set their own. The prompt itself is kept, so you can set it again later."
					: "This action will fall back to your organization's default, or the universal one. The prompt itself is kept, so you can set it again later.",
			confirmLabel: "Clear override",
			cancelLabel: "Cancel",
			onConfirm: () => clearMutation.mutate(),
		});
	};
	const [imageError, setImageError] = useState(false);
	const videoRef = useRef<HTMLVideoElement>(null);
	const [_isVisible, setIsVisible] = useState(false);

	const promptType = prompt.promptType || "TEXT";
	const isVideo = promptType === "VIDEO";
	const isAudio = promptType === "AUDIO";
	const isStructuredInput = !!prompt.structuredFormat;
	const hasMediaBackground =
		promptType === "IMAGE" ||
		isVideo ||
		(isStructuredInput && !!prompt.mediaUrl && !isAudio);

	const content = prompt.versions?.[0]?.content || "";
	const contentHasVariables = hasVariables(content);

	// Autoplay video when visible
	useEffect(() => {
		if (!isVideo || !videoRef.current) {
			return;
		}

		const observer = new IntersectionObserver(
			([entry]) => {
				setIsVisible(entry.isIntersecting);
				if (entry.isIntersecting) {
					videoRef.current?.play().catch(() => {});
				} else {
					videoRef.current?.pause();
				}
			},
			{ threshold: 0.3 },
		);

		observer.observe(videoRef.current);
		return () => observer.disconnect();
	}, [isVideo]);

	const copyToClipboard = async () => {
		await navigator.clipboard.writeText(content);
		toast.success("Copied to clipboard");
	};

	const getPromptUrl = () => `${basePath}/prompts/${prompt.id}`;

	const authorName =
		prompt.author?.name ||
		prompt.author?.username ||
		prompt.createdBy ||
		"Unknown";
	const authorInitial = authorName.charAt(0).toUpperCase();

	return (
		<div
			className={`group border rounded-[var(--radius)] overflow-hidden hover:border-foreground/20 transition-colors flex flex-col ${hasMediaBackground || isAudio ? "" : "p-4"}`}
		>
			{/* Image/Video Background */}
			{hasMediaBackground && (
				<div className="relative bg-muted">
					{prompt.mediaUrl && !imageError ? (
						isVideo ? (
							<video
								ref={videoRef}
								src={prompt.mediaUrl}
								className="w-full object-cover"
								style={{ maxHeight: "400px" }}
								muted
								loop
								playsInline
								preload="metadata"
							/>
						) : (
							// biome-ignore lint/performance/noImgElement: user-uploaded media with unknown dimensions
							<img
								src={prompt.mediaUrl}
								alt={prompt.name}
								className="w-full object-cover object-top"
								style={{ maxHeight: "400px" }}
								onError={() => setImageError(true)}
							/>
						)
					) : (
						<div className="h-32 flex items-center justify-center">
							{isVideo ? (
								<Video className="h-8 w-8 text-muted-foreground/30" />
							) : (
								<ImageIcon className="h-8 w-8 text-muted-foreground/30" />
							)}
						</div>
					)}
					<div className="absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent pointer-events-none" />
					{/* Type and format badge overlay */}
					<div className="absolute top-2 right-2 flex items-center gap-1.5">
						<Badge
							variant="secondary"
							className="text-[10px] bg-background/80 backdrop-blur-sm"
						>
							{promptType.toLowerCase()}
						</Badge>
						{prompt.format && prompt.format !== "PLAIN_TEXT" && (
							<Badge
								variant="outline"
								className="text-[10px] bg-background/80 backdrop-blur-sm"
							>
								{getFormatDisplayName(prompt.format)}
							</Badge>
						)}
					</div>
				</div>
			)}

			<div
				className={
					hasMediaBackground || isAudio
						? "p-3 flex-1 flex flex-col"
						: "flex-1 flex flex-col"
				}
			>
				{/* Header */}
				<div className="flex items-start justify-between gap-2 mb-2">
					<div className="flex items-center gap-1 flex-1 min-w-0">
						{!prompt.isPublic && (
							<Lock className="h-3 w-3 text-muted-foreground shrink-0" />
						)}
						<Link
							href={getPromptUrl()}
							prefetch={false}
							className="font-medium text-sm hover:underline line-clamp-1"
						>
							{prompt.name}
						</Link>
						<PromptDefaultBadge
							isDefault={prompt.isDefault}
							isBound={prompt.isBound}
							defaultScope={prompt.defaultScope}
							className="text-[10px]"
						/>
					</div>
					<div className="flex items-center gap-1 shrink-0">
						{!hasMediaBackground && (
							<>
								<Badge
									variant="outline"
									className="text-[10px]"
								>
									{promptType.toLowerCase()}
								</Badge>
								{prompt.format &&
									prompt.format !== "PLAIN_TEXT" && (
										<Badge
											variant="secondary"
											className="text-[10px]"
										>
											{getFormatDisplayName(
												prompt.format,
											)}
										</Badge>
									)}
							</>
						)}
						<DropdownMenu>
							{/* Stays visible while it is busy: the menu has
							    already closed, so a trigger that faded out
							    would leave the wait with no on-screen home. */}
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									{...deletion.triggerProps}
									className={`p-1 rounded hover:bg-accent transition-opacity focus:opacity-100 ${
										deletion.isPreparing
											? "opacity-100"
											: "md:opacity-0 md:group-hover:opacity-100"
									}`}
								>
									{deletion.isPreparing ? (
										<Spinner className="size-3.5 motion-reduce:animate-none" />
									) : (
										<MoreVerticalIcon className="h-3.5 w-3.5 text-muted-foreground" />
									)}
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => setPreviewOpen(true)}
								>
									<Play className="mr-2 h-4 w-4" />
									Preview
								</DropdownMenuItem>
								{isEditable && (
									<DropdownMenuItem
										onClick={() =>
											router.push(getPromptUrl())
										}
									>
										<EditIcon className="mr-2 h-4 w-4" />
										Edit
									</DropdownMenuItem>
								)}
								<DropdownMenuItem onClick={handleDuplicate}>
									<CopyIcon className="mr-2 h-4 w-4" />
									Duplicate
								</DropdownMenuItem>
								{latestVersionId && (
									<DropdownMenuItem
										onClick={() => setSetDefaultOpen(true)}
									>
										<Link2Icon className="mr-2 h-4 w-4" />
										Set as Default
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									onClick={() =>
										router.push(
											`${basePath}/prompts/catalog?prompt=${prompt.id}`,
										)
									}
								>
									<LibraryIcon className="mr-2 h-4 w-4" />
									View in Catalog
								</DropdownMenuItem>
								{clearableBinding && (
									<DropdownMenuItem
										onClick={handleClearOverride}
										disabled={clearMutation.isPending}
									>
										<Link2OffIcon className="mr-2 h-4 w-4" />
										Clear Default Override
									</DropdownMenuItem>
								)}
								{deletion.canDelete && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												deletion.requestDelete()
											}
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

				{/* Description */}
				{prompt.description && (
					<p className="text-xs text-muted-foreground line-clamp-2 mb-2">
						{prompt.description}
					</p>
				)}

				{/* Content Preview */}
				<div className="relative flex-1 mb-3 min-h-0">
					<pre
						className={`text-xs text-muted-foreground bg-muted p-2 rounded overflow-hidden font-mono h-full whitespace-pre-wrap break-words ${hasMediaBackground ? "line-clamp-2" : "line-clamp-4"}`}
					>
						{contentHasVariables
							? renderContentWithVariables(content)
							: content || "No content yet"}
					</pre>
				</div>

				{/* Tags */}
				{prompt.tags && prompt.tags.length > 0 && (
					<div className="flex flex-wrap gap-1 mb-3">
						{prompt.tags.slice(0, 3).map((tag) => (
							<PromptTag key={tag}>{tag}</PromptTag>
						))}
						{prompt.tags.length > 3 && (
							<span className="text-[10px] text-muted-foreground">
								+{prompt.tags.length - 3}
							</span>
						)}
					</div>
				)}

				{/* Footer */}
				<div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t mt-auto">
					<div className="flex items-center gap-1.5">
						<Avatar className="h-4 w-4">
							<AvatarImage
								src={prompt.author?.avatar || undefined}
							/>
							<AvatarFallback className="text-[8px]">
								{authorInitial}
							</AvatarFallback>
						</Avatar>
						<span>{authorName}</span>
					</div>
					<div className="flex items-center gap-2">
						<UpvoteButton
							promptId={prompt.id}
							initialVoted={false}
							initialCount={prompt.voteCount ?? 0}
							size="sm"
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={copyToClipboard}
									className="p-1 rounded hover:bg-accent"
									aria-label={tTooltips("copy")}
								>
									<Copy className="h-3 w-3" />
								</button>
							</TooltipTrigger>
							<TooltipContent>{tTooltips("copy")}</TooltipContent>
						</Tooltip>
						<Link
							href={getPromptUrl()}
							className="h-6 w-6 rounded hover:bg-accent flex items-center justify-center"
							title="View prompt"
						>
							<Play className="h-4 w-4" />
						</Link>
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
					storyKind={storyKindContext}
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
		</div>
	);
}
