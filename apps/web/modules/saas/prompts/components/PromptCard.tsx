"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { Badge } from "@ui/components/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	ArrowRightIcon,
	Copy,
	CopyIcon,
	EditIcon,
	EyeIcon,
	ImageIcon,
	LibraryIcon,
	Link2Icon,
	MoreVerticalIcon,
	TrashIcon,
	Video,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { usePromptDeletion } from "../hooks/use-prompt-deletion";
import { PromptDefaultBadge } from "./PromptDefaultBadge";
import { PromptPreviewSheet } from "./PromptPreviewSheet";
import { PromptScopeBadge } from "./PromptScopeBadge";
import { SetAsDefaultDialog } from "./SetAsDefaultDialog";
import { UpvoteButton } from "./UpvoteButton";

// Get display name for format
function getFormatDisplayName(format: string): string {
	const formatNames: Record<string, string> = {
		PLAIN_TEXT: "Plain text",
		MARKDOWN: "Markdown",
		HANDLEBARS: "Handlebars",
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
};

export function PromptCard({
	prompt,
	onUpdate,
	showPinButton: _showPinButton = false,
	isPinned: _isPinned = false,
	storyKindContext,
}: Props) {
	const router = useRouter();
	const { basePath, userRole } = useOrganizationContext();
	const [setDefaultOpen, setSetDefaultOpen] = useState(false);
	const [previewOpen, setPreviewOpen] = useState(false);

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
		router.push(`${basePath}/prompts/new?duplicateFrom=${prompt.id}`);
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
		try {
			await navigator.clipboard.writeText(content);
			toast.success("Copied to clipboard");
		} catch {
			toast.error(
				"Could not copy the prompt. Open it to select and copy the text.",
			);
		}
	};

	const getPromptUrl = () => `${basePath}/prompts/${prompt.id}`;

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
				{/* The name gets the full width and up to two lines; the
				    badges sit on their own row beneath it. Beside each other
				    the badges won and the name was cut to one word. */}
				<div className="mb-2 space-y-1.5">
					<div className="flex items-start justify-between gap-2">
						<Link
							href={getPromptUrl()}
							onClick={(event) => {
								if (
									!event.metaKey &&
									!event.ctrlKey &&
									!event.shiftKey &&
									!event.altKey
								) {
									event.preventDefault();
									setPreviewOpen(true);
								}
							}}
							prefetch={false}
							className="min-w-0 flex-1 font-semibold text-base leading-snug hover:underline line-clamp-2"
						>
							{prompt.name}
						</Link>
						<div className="flex items-center gap-1 shrink-0">
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
										<EyeIcon className="mr-2 h-4 w-4" />
										Preview
									</DropdownMenuItem>
									{isEditable && (
										<DropdownMenuItem
											onClick={() =>
												router.push(
													`${getPromptUrl()}?edit=1&returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`,
												)
											}
										>
											<EditIcon className="mr-2 h-4 w-4" />
											Edit
										</DropdownMenuItem>
									)}
									<DropdownMenuItem onClick={copyToClipboard}>
										<Copy className="mr-2 h-4 w-4" />
										Copy prompt text
									</DropdownMenuItem>
									<DropdownMenuItem onClick={handleDuplicate}>
										<CopyIcon className="mr-2 h-4 w-4" />
										Duplicate
									</DropdownMenuItem>
									{latestVersionId && (
										<DropdownMenuItem
											onClick={() =>
												setSetDefaultOpen(true)
											}
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
					<div className="flex flex-wrap items-center gap-1">
						<PromptDefaultBadge
							isDefault={prompt.isDefault}
							isBound={prompt.isBound}
							defaultScope={prompt.defaultScope}
							className="text-[10px]"
						/>
						<PromptScopeBadge scope={prompt.scope} />
						{!hasMediaBackground && (
							<span className="text-xs text-muted-foreground">
								{getFormatDisplayName(prompt.format)}
							</span>
						)}
					</div>
				</div>

				{/* Description */}
				{prompt.description && (
					<p className="text-sm leading-6 text-muted-foreground line-clamp-3 mb-5">
						{prompt.description}
					</p>
				)}

				{/* Footer */}
				<div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t mt-auto">
					<span className="text-xs">
						{prompt.category?.replaceAll("-", " ") ||
							"Reusable prompt"}
					</span>
					<div className="flex items-center gap-2">
						{(prompt.voteCount ?? 0) > 0 && (
							<UpvoteButton
								promptId={prompt.id}
								initialVoted={false}
								initialCount={prompt.voteCount ?? 0}
								size="sm"
							/>
						)}
						<Link
							href={getPromptUrl()}
							onClick={(event) => {
								if (
									!event.metaKey &&
									!event.ctrlKey &&
									!event.shiftKey &&
									!event.altKey
								) {
									event.preventDefault();
									setPreviewOpen(true);
								}
							}}
							className="inline-flex min-h-9 items-center gap-1 rounded px-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
							aria-label={`Open ${prompt.name}`}
						>
							Open{" "}
							<ArrowRightIcon
								className="h-4 w-4"
								aria-hidden="true"
							/>
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
				fullPageEdit
				promptId={prompt.id}
				onPromptUpdated={onUpdate}
			/>
		</div>
	);
}
