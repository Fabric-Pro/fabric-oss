"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Trash2Icon } from "lucide-react";

interface SwipeableChatItemProps {
	chat: {
		id: string;
		title?: string | null;
		messages?: any;
		createdAt: Date | string;
		updatedAt: Date | string;
		pinned?: boolean;
	};
	isActive: boolean;
	onSelect: () => void;
	onDelete: () => void;
}

export function SwipeableChatItem({
	chat,
	isActive,
	onSelect,
	onDelete,
}: SwipeableChatItemProps) {
	const handleDelete = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (!window.confirm("Delete this conversation?")) {
			return;
		}
		onDelete();
	};

	return (
		<div className="group relative">
			<Button
				variant="ghost"
				onClick={onSelect}
				className={cn(
					"h-auto w-full justify-start rounded-xl px-2.5 py-1.5 pr-9 text-left transition-colors",
					isActive
						? "bg-muted/80 text-foreground/85"
						: "text-muted-foreground hover:bg-muted/45 hover:text-foreground/85",
				)}
			>
				<span className="w-full min-w-0 overflow-hidden">
					<span
						className="block truncate text-[12.5px] font-medium leading-5"
						title={
							chat.title ??
							(chat.messages?.at(0) as any)?.content ??
							"Untitled chat"
						}
					>
						{chat.title ??
							(chat.messages?.at(0) as any)?.content ??
							"Untitled chat"}
					</span>
				</span>
			</Button>

			{/* Delete button — appears on hover */}
			<div className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100">
				<Button
					variant="ghost"
					size="icon"
					className="size-6 rounded-md text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive"
					onClick={handleDelete}
					title="Delete conversation"
				>
					<Trash2Icon className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}
