"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import { FolderIcon, MessageSquareIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import type { HomeProjectShortcut } from "../lib/home-model";

interface ContinueConversation {
	id: string;
	title: string | null;
	updatedAt: string | Date;
}

interface ContinuePanelProps {
	shortcuts: Array<HomeProjectShortcut & { isFavorite: boolean }>;
	conversations: ContinueConversation[];
	loading: boolean;
	basePath: string;
}

function date(value: string | Date): Date {
	return value instanceof Date ? value : new Date(value);
}

export function ContinuePanel({
	shortcuts,
	conversations,
	loading,
	basePath,
}: ContinuePanelProps) {
	return (
		<Card className="flex h-96 flex-col">
			<CardHeader className="px-5 pb-3 pt-4">
				<CardTitle className="text-base">Continue</CardTitle>
			</CardHeader>
			<CardContent className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
				{loading ? (
					<div className="space-y-4 px-3">
						{Array.from({ length: 4 }, (_, index) => (
							<Skeleton key={index} className="h-10 w-full" />
						))}
					</div>
				) : shortcuts.length === 0 && conversations.length === 0 ? (
					<div className="px-3 py-8 text-center">
						<p className="text-sm font-medium">
							Start with a project
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Favorites and recently visited work will appear
							here.
						</p>
						<Link
							href={`${basePath}/projects/new`}
							className="mt-3 inline-block text-xs font-medium text-primary-ink hover:underline"
						>
							Create a project
						</Link>
					</div>
				) : (
					<div className="space-y-4">
						{shortcuts.length > 0 ? (
							<div>
								<p className="px-3 pb-1 text-xs font-semibold text-muted-foreground">
									Projects
								</p>
								{shortcuts.map((project) => (
									<Link
										key={project.id}
										href={`${project.organizationSlug ? `/app/${project.organizationSlug}` : basePath}/projects/${project.id}`}
										className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:bg-muted/50"
									>
										<FolderIcon
											className="size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-medium">
												{project.name}
											</span>
											{project.lastVisitedAt ? (
												<span className="block text-xs text-muted-foreground">
													Opened{" "}
													{formatDistanceToNow(
														date(
															project.lastVisitedAt,
														),
														{ addSuffix: true },
													)}
												</span>
											) : null}
										</span>
										{project.isFavorite ? (
											<StarIcon
												className="size-3.5 shrink-0 fill-current text-primary"
												aria-label="Favorite"
											/>
										) : null}
									</Link>
								))}
							</div>
						) : null}
						{conversations.length > 0 ? (
							<div>
								<p className="px-3 pb-1 text-xs font-semibold text-muted-foreground">
									Recent chats
								</p>
								{conversations.map((conversation) => (
									<Link
										key={conversation.id}
										href={`${basePath}/agents/fabric-ai?c=${conversation.id}`}
										className="flex items-center gap-3 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:bg-muted/50"
									>
										<MessageSquareIcon
											className="size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-medium">
												{conversation.title ||
													"Untitled chat"}
											</span>
											<span className="block text-xs text-muted-foreground">
												{formatDistanceToNow(
													date(
														conversation.updatedAt,
													),
													{ addSuffix: true },
												)}
											</span>
										</span>
									</Link>
								))}
							</div>
						) : null}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
