"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { cn } from "@ui/lib";
import { Loader2, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface UpvoteButtonProps {
	promptId: string;
	initialVoted: boolean;
	initialCount: number;
	size?: "sm" | "default" | "circular";
	showLabel?: boolean;
}

export function UpvoteButton({
	promptId,
	initialVoted,
	initialCount,
	size = "default",
	showLabel = false,
}: UpvoteButtonProps) {
	const { user } = useSession();
	const isLoggedIn = !!user;
	const [isVoted, setIsVoted] = useState(initialVoted);
	const [voteCount, setVoteCount] = useState(initialCount);
	const [isLoading, setIsLoading] = useState(false);

	const handleVote = async () => {
		if (!isLoggedIn) {
			toast.error("Please log in to vote on prompts");
			return;
		}

		setIsLoading(true);

		try {
			const method = isVoted ? "DELETE" : "POST";
			const response = await fetch(`/api/prompts/${promptId}/vote`, {
				method,
			});

			if (!response.ok) {
				throw new Error("Failed to vote");
			}

			const data = await response.json();
			setIsVoted(data.voted);
			setVoteCount(data.voteCount);
		} catch {
			toast.error("Failed to vote");
		} finally {
			setIsLoading(false);
		}
	};

	if (size === "circular") {
		return (
			<button
				type="button"
				onClick={handleVote}
				disabled={isLoading}
				className={cn(
					"flex flex-col items-center justify-center w-14 h-14 rounded-full border-2 transition-all",
					isVoted
						? "bg-primary text-primary-foreground border-primary"
						: "bg-background text-muted-foreground border-border hover:border-primary hover:text-primary",
				)}
			>
				{isLoading ? (
					<Loader2 className="h-5 w-5 animate-spin" />
				) : (
					<>
						<ThumbsUp
							className={cn("h-5 w-5", isVoted && "fill-current")}
						/>
						<span className="text-xs font-medium mt-0.5">
							{voteCount}
						</span>
					</>
				)}
			</button>
		);
	}

	if (size === "sm") {
		return (
			<button
				type="button"
				onClick={handleVote}
				disabled={isLoading}
				className={cn(
					"flex items-center gap-1 text-xs transition-colors",
					isVoted
						? "text-primary"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				{isLoading ? (
					<Loader2 className="h-3 w-3 animate-spin" />
				) : (
					<ThumbsUp
						className={cn("h-3 w-3", isVoted && "fill-current")}
					/>
				)}
				<span>{voteCount}</span>
			</button>
		);
	}

	// default size
	return (
		<button
			type="button"
			onClick={handleVote}
			disabled={isLoading}
			className={cn(
				"flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-all",
				isVoted
					? "border-primary bg-primary text-primary-foreground"
					: "border-border bg-background text-muted-foreground hover:border-primary hover:text-primary",
			)}
		>
			{isLoading ? (
				<Loader2 className="h-4 w-4 animate-spin" />
			) : (
				<ThumbsUp
					className={cn("h-4 w-4", isVoted && "fill-current")}
				/>
			)}
			<span>
				{voteCount}
				{showLabel && ` ${voteCount === 1 ? "upvote" : "upvotes"}`}
			</span>
		</button>
	);
}
