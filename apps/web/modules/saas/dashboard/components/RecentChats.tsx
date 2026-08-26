"use client";

import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { formatDistanceToNow } from "date-fns";
import { ExternalLinkIcon, MessageSquareIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";

interface ChatItem {
	id: string;
	title: string;
	timestamp: Date;
}

interface RecentChatsProps {
	chats: ChatItem[];
	organizationSlug?: string;
	loading?: boolean;
}

export function RecentChats({
	chats,
	organizationSlug,
	loading,
}: RecentChatsProps) {
	const router = useRouter();
	const basePath = organizationSlug ? `/app/${organizationSlug}` : "/app";
	const chatbotPath = `${basePath}/nexus`;

	const displayChats = chats.slice(0, 10);

	return (
		<Card className="flex h-full flex-col">
			<CardHeader className="shrink-0 px-5 pb-3 pt-4">
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="text-base font-semibold">
						Recent Chats
					</CardTitle>
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							size="sm"
							className="h-7 text-xs text-muted-foreground"
							onClick={() => router.push(chatbotPath)}
						>
							View all
							<ExternalLinkIcon className="ml-1 h-3 w-3" />
						</Button>
						<Button
							size="sm"
							className="h-7 text-xs"
							onClick={() => router.push(chatbotPath)}
						>
							<PlusIcon className="mr-1 h-3 w-3" />
							New chat
						</Button>
					</div>
				</div>
			</CardHeader>

			<CardContent className="flex-1 overflow-y-auto p-0 pb-2">
				{loading ? (
					<div className="space-y-1 px-5 pt-1">
						{[...Array(8)].map((_, i) => (
							<div
								key={`skeleton-chat-${i}`}
								className="flex items-center gap-3 py-2.5"
							>
								<div className="h-6 w-6 animate-pulse rounded-full bg-muted shrink-0" />
								<div className="flex-1 space-y-1.5">
									<div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
									<div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
								</div>
							</div>
						))}
					</div>
				) : displayChats.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center gap-3 px-5 py-10 text-center">
						<MessageSquareIcon className="h-8 w-8 text-muted-foreground/30" />
						<div>
							<p className="text-sm font-medium text-muted-foreground">
								No conversations yet
							</p>
							<p className="mt-0.5 text-xs text-muted-foreground/60">
								Start a chat to get AI assistance
							</p>
						</div>
						<Button
							size="sm"
							variant="outline"
							className="mt-1"
							onClick={() => router.push(chatbotPath)}
						>
							<PlusIcon className="mr-1.5 h-3.5 w-3.5" />
							Start a chat
						</Button>
					</div>
				) : (
					<div className="divide-y divide-border/40">
						{displayChats.map((chat) => (
							<button
								key={chat.id}
								type="button"
								className="group flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/30"
								onClick={() =>
									router.push(`${chatbotPath}?c=${chat.id}`)
								}
							>
								<div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
									<MessageSquareIcon className="h-3.5 w-3.5 text-primary" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium leading-tight group-hover:text-primary transition-colors">
										{chat.title || "Untitled Chat"}
									</p>
									<p className="mt-0.5 text-[11px] text-muted-foreground/60">
										{formatDistanceToNow(chat.timestamp, {
											addSuffix: true,
										})}
									</p>
								</div>
							</button>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
