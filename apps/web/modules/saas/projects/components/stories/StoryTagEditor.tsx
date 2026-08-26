"use client";

import { tagValueSchema } from "@repo/utils/tag-value";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { HashIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";

type Tag = { id: string; value: string; createdById: string | null };

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	tags: Tag[];
	currentUserId: string | undefined;
	canAddTags: boolean;
	canManageAllTags: boolean;
	/** When set and tags exceed it, collapse the chip list behind a
	 * Show more/less toggle. Unset = render all. */
	maxVisible?: number;
};

export function StoryTagEditor({
	projectId,
	storyId,
	organizationId,
	tags,
	currentUserId,
	canAddTags,
	canManageAllTags,
	maxVisible,
}: Props) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	const collapsed =
		maxVisible != null && !expanded && tags.length > maxVisible;
	const visibleTags = collapsed ? tags.slice(0, maxVisible) : tags;

	const tagsListKey = orpc.projects.stories.tags.list.queryKey({
		input: { projectId, organizationId },
	});
	const storiesListKey = orpc.projects.stories.list.queryKey({
		input: { projectId, organizationId },
	});
	const storyGetKey = orpc.projects.stories.get.queryKey({
		input: { projectId, storyId, organizationId },
	});
	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: tagsListKey });
		queryClient.invalidateQueries({ queryKey: storiesListKey });
		queryClient.invalidateQueries({ queryKey: storyGetKey });
	};

	const suggestionsQuery = useQuery({
		...orpc.projects.stories.tags.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: canAddTags && open,
	});

	const addMutation = useMutation({
		mutationFn: (value: string) =>
			orpcClient.projects.stories.tags.add({
				projectId,
				storyId,
				organizationId,
				value,
			}),
		onSuccess: () => {
			setDraft("");
			invalidateAll();
		},
		onError: (error) => {
			toast.error("Failed to add tag", { description: error.message });
		},
	});

	const removeMutation = useMutation({
		mutationFn: (tagId: string) =>
			orpcClient.projects.stories.tags.remove({
				projectId,
				storyId,
				organizationId,
				tagId,
			}),
		onSuccess: invalidateAll,
		onError: (error) => {
			toast.error("Failed to remove tag", { description: error.message });
		},
	});

	// A creator may remove their own tag only if their effective role still
	// grants STORY_UPDATE (i.e. `canAddTags`) — the server's `tags.remove`
	// gates on STORY_UPDATE BEFORE the creator-or-admin check, so a demoted
	// creator is blocked server-side and must not see a button it rejects.
	const canRemove = (tag: Tag) =>
		canManageAllTags ||
		(canAddTags &&
			tag.createdById != null &&
			tag.createdById === currentUserId);

	const submit = (raw: string) => {
		const parsed = tagValueSchema.safeParse(raw);
		if (!parsed.success) {
			// Inline validation error (spec AC: e.g. the 50-char inline error),
			// rendered next to the input — NOT a transient toast.
			setError(parsed.error.issues[0]?.message ?? "Invalid tag");
			return;
		}
		if (tags.some((t) => t.value === parsed.data)) {
			toast.error("Tag already added");
			return;
		}
		setError(null);
		addMutation.mutate(parsed.data);
	};

	const suggestions = (suggestionsQuery.data?.tags ?? []).filter(
		(value) => !tags.some((t) => t.value === value),
	);

	return (
		<div className="space-y-1.5">
			<Label className="flex items-center gap-2">
				<HashIcon className="size-4" />
				Tags
			</Label>
			<div className="flex min-h-[32px] flex-wrap gap-1">
				{visibleTags.map((tag) => (
					<Badge key={tag.id} variant="secondary" className="gap-1">
						{tag.value}
						{canRemove(tag) && (
							<button
								type="button"
								aria-label={`Remove tag ${tag.value}`}
								onClick={() => removeMutation.mutate(tag.id)}
								className="ml-1 hover:text-destructive"
							>
								<XIcon className="size-3" />
							</button>
						)}
					</Badge>
				))}
				{tags.length === 0 && (
					<span className="text-muted-foreground text-xs">
						No tags
					</span>
				)}
			</div>

			{maxVisible != null && tags.length > maxVisible && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="text-muted-foreground text-xs underline hover:text-foreground"
				>
					{collapsed
						? `Show more (${tags.length - maxVisible})`
						: "Show less"}
				</button>
			)}

			{canAddTags && (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<button
							type="button"
							className={cn(
								"inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-transparent px-2.5 text-sm font-medium text-muted-foreground hover:text-foreground",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							)}
						>
							<PlusIcon className="size-4" />
							Add tag
						</button>
					</PopoverTrigger>
					<PopoverContent align="start" className="w-64 p-0">
						<Command shouldFilter={false}>
							<CommandInput
								value={draft}
								onValueChange={(v) => {
									setDraft(v);
									setError(null);
								}}
								placeholder="Add tag…"
								onKeyDown={(e) => {
									if (e.key === "Enter" && draft.trim()) {
										e.preventDefault();
										submit(draft);
									}
								}}
							/>
							<CommandList>
								<CommandEmpty>
									{draft.trim()
										? `Press Enter to create "${draft.trim().toLowerCase()}"`
										: "Type to add a tag"}
								</CommandEmpty>
								<CommandGroup>
									{suggestions
										.filter((s) =>
											s.includes(
												draft.trim().toLowerCase(),
											),
										)
										.map((value) => (
											<CommandItem
												key={value}
												value={value}
												onSelect={() => submit(value)}
											>
												{value}
											</CommandItem>
										))}
								</CommandGroup>
							</CommandList>
						</Command>
					</PopoverContent>
				</Popover>
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
		</div>
	);
}
