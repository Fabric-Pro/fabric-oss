"use client";

import { ORPCError } from "@orpc/client";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, FolderIcon, RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";

/**
 * Whether a project that did not load is genuinely absent, rather than the read
 * having failed. Only an empty answer or a NOT_FOUND says the project is not
 * there; a FORBIDDEN (for instance a session still naming the previous
 * workspace right after sign-in), a 5xx or a transport failure says nothing
 * about the project, and calling it "not found" strands the user on a page a
 * retry would have fixed.
 */
export function isProjectNotFound(error: unknown): boolean {
	return !error || (error instanceof ORPCError && error.code === "NOT_FOUND");
}

/**
 * What the project page shows when `projects.get` produced no project: a
 * not-found state for an absent project, otherwise a load error with a retry.
 */
export function ProjectUnavailable({
	error,
	basePath,
	onRetry,
	isRetrying,
}: {
	error: unknown;
	basePath: string;
	onRetry: () => void;
	isRetrying: boolean;
}) {
	const router = useRouter();
	const notFound = isProjectNotFound(error);

	return (
		<div className="flex flex-col items-center justify-center py-12">
			<div className="mb-4 rounded-2xl bg-muted p-4">
				{notFound ? (
					<FolderIcon className="size-8 text-muted-foreground" />
				) : (
					<AlertTriangleIcon className="size-8 text-muted-foreground" />
				)}
			</div>
			<p className="mb-2 font-medium text-foreground/70">
				{notFound ? "Project not found" : "Couldn't load this project"}
			</p>
			<p className="mb-6 text-foreground/50 text-sm">
				{notFound
					? "The project you're looking for doesn't exist or has been deleted."
					: "Something went wrong while loading it. Try again in a moment."}
			</p>
			<div className="flex gap-2">
				{!notFound && (
					<Button
						onClick={onRetry}
						disabled={isRetrying}
						className="gap-2"
					>
						<RotateCcwIcon className="size-4" />
						{isRetrying ? "Retrying…" : "Try again"}
					</Button>
				)}
				<Button
					variant={notFound ? "primary" : "outline"}
					onClick={() => router.push(`${basePath}/projects`)}
					className="gap-2"
				>
					Back to Projects
				</Button>
			</div>
		</div>
	);
}
