"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	EmptyState,
	EmptyStateAction,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { useToast } from "@ui/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import {
	Frame,
	ImageIcon,
	Loader2,
	MoreHorizontal,
	Presentation,
	Sparkles,
	Trash,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { TemplateGallery } from "./template-gallery";

interface FramesListProps {
	organizationId?: string | null;
	organizationSlug?: string;
}

export function FramesList({
	organizationId,
	organizationSlug,
}: FramesListProps) {
	const { toast } = useToast();
	const queryClient = useQueryClient();
	const [isDuplicating, setIsDuplicating] = useState<string | null>(null);
	const [frameToDelete, setFrameToDelete] = useState<{
		id: string;
		title: string;
	} | null>(null);
	const [showTemplateGallery, setShowTemplateGallery] = useState(false);

	const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } =
		useInfiniteQuery({
			queryKey: ["frames", "list", organizationId ?? null],
			queryFn: async ({ pageParam = 0 }) => {
				const response = await orpcClient.frames.list({
					organizationId: organizationId ?? null,
					limit: 20,
					offset: pageParam,
				});
				return response;
			},
			getNextPageParam: (lastPage, pages) => {
				if (lastPage.length < 20) {
					return undefined;
				}
				return pages.length * 20;
			},
			initialPageParam: 0,
		});

	const frames = data?.pages.flat() ?? [];

	const deleteMutation = useMutation({
		mutationFn: async (frameId: string) => {
			return await orpcClient.frames.delete({
				id: frameId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["frames", "list"] });
			toast({
				title: "Frame deleted",
				description: "The frame has been permanently deleted.",
			});
			setFrameToDelete(null);
		},
		onError: () => {
			toast({
				title: "Failed to delete",
				description: "Please try again.",
				variant: "destructive",
			});
		},
	});

	const handleDuplicate = async (frameId: string) => {
		setIsDuplicating(frameId);
		try {
			const result = await orpcClient.frames.duplicate({
				id: frameId,
				organizationId: organizationId ?? null,
			});
			toast({
				title: "Frame duplicated",
				description: `"${result.title}" has been created.`,
			});
		} catch (_error) {
			toast({
				title: "Failed to duplicate",
				description: "Please try again.",
				variant: "destructive",
			});
		} finally {
			setIsDuplicating(null);
		}
	};

	const getFrameUrl = (frameId: string) => {
		if (organizationSlug) {
			return `/app/${organizationSlug}/frames/${frameId}`;
		}
		return `/app/frames/${frameId}`;
	};

	if (isLoading) {
		return (
			<div className="flex h-64 items-center justify-center">
				<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (frames.length === 0) {
		return (
			<>
				<EmptyState>
					<EmptyStateIcon>
						<Frame className="h-10 w-10" />
					</EmptyStateIcon>
					<EmptyStateTitle>No frames yet</EmptyStateTitle>
					<EmptyStateDescription>
						Frames are interactive visual artifacts created by AI
						agents. Create one from a template or conversation.
					</EmptyStateDescription>
					<EmptyStateAction>
						<Button
							variant="outline"
							onClick={() => setShowTemplateGallery(true)}
							className="gap-2"
						>
							<Sparkles className="h-4 w-4" />
							Create from Template
						</Button>
					</EmptyStateAction>
				</EmptyState>
				<TemplateGallery
					open={showTemplateGallery}
					onOpenChange={setShowTemplateGallery}
					onFrameCreated={(frameId) => {
						window.location.href = getFrameUrl(frameId);
					}}
				/>
			</>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header with Create from Template button */}
			<div className="flex justify-end">
				<Button
					variant="outline"
					onClick={() => setShowTemplateGallery(true)}
					className="gap-2"
				>
					<Sparkles className="h-4 w-4" />
					Create from Template
				</Button>
			</div>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{frames.map((frame) => (
					<Card key={frame.id} className="group flex flex-col">
						<CardHeader className="pb-3">
							<div className="flex items-start justify-between gap-2">
								<div className="flex items-center gap-2">
									{frame.kind === "slideshow" ? (
										<Presentation className="h-4 w-4 text-muted-foreground" />
									) : (
										<ImageIcon className="h-4 w-4 text-muted-foreground" />
									)}
									<CardTitle className="line-clamp-1 text-base">
										{frame.title}
									</CardTitle>
								</div>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="h-8 w-8 opacity-0 group-hover:opacity-100"
										>
											<MoreHorizontal className="h-4 w-4" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem asChild>
											<Link href={getFrameUrl(frame.id)}>
												View
											</Link>
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												handleDuplicate(frame.id)
											}
											disabled={
												isDuplicating === frame.id
											}
										>
											{isDuplicating === frame.id ? (
												<>
													<Loader2 className="mr-2 h-4 w-4 animate-spin" />
													Duplicating...
												</>
											) : (
												<>Duplicate</>
											)}
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												setFrameToDelete({
													id: frame.id,
													title: frame.title,
												})
											}
											className="text-destructive"
										>
											<Trash className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
							<CardDescription className="line-clamp-2">
								{frame.description || "No description"}
							</CardDescription>
						</CardHeader>
						<CardContent className="mt-auto pt-0">
							<div className="flex items-center justify-between text-xs text-muted-foreground">
								<div className="flex items-center gap-2">
									<Badge
										variant="secondary"
										className="text-xs"
									>
										{frame.kind === "slideshow"
											? "Slideshow"
											: "Frame"}
									</Badge>
									{frame.isPublic && (
										<Badge
											variant="outline"
											className="text-xs"
										>
											Shared
										</Badge>
									)}
								</div>
								<span>
									{formatDistanceToNow(
										new Date(frame.updatedAt),
										{
											addSuffix: true,
										},
									)}
								</span>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{hasNextPage && (
				<div className="flex justify-center">
					<Button
						variant="outline"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
					>
						{isFetchingNextPage ? (
							<>
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								Loading...
							</>
						) : (
							<>Load more</>
						)}
					</Button>
				</div>
			)}

			{/* Delete Confirmation Dialog */}
			<Dialog
				open={!!frameToDelete}
				onOpenChange={() => setFrameToDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete Frame</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete &quot;
							{frameToDelete?.title}&quot;? This action cannot be
							undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setFrameToDelete(null)}
							disabled={deleteMutation.isPending}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (frameToDelete) {
									deleteMutation.mutate(frameToDelete.id);
								}
							}}
							disabled={deleteMutation.isPending}
						>
							{deleteMutation.isPending ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Deleting...
								</>
							) : (
								<>Delete</>
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Template Gallery Dialog */}
			<TemplateGallery
				open={showTemplateGallery}
				onOpenChange={setShowTemplateGallery}
				onFrameCreated={(frameId) => {
					window.location.href = getFrameUrl(frameId);
				}}
			/>
		</div>
	);
}
