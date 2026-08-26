"use client";

import { Button } from "@ui/components/button";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect } from "react";

export default function DocumentError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const params = useParams();
	const projectId = params?.id as string;
	const organizationSlug = params?.organizationSlug as string;

	useEffect(() => {
		console.error("[DocumentEditor] Client-side error:", error);
	}, [error]);

	const backUrl = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}?tab=documents`
		: "/app";

	return (
		<div className="fixed inset-y-0 right-0 left-0 bg-background flex items-center justify-center md:left-[72px]">
			<div className="max-w-md text-center space-y-4">
				<AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
				<h2 className="text-lg font-semibold">
					Failed to load document editor
				</h2>
				<p className="text-sm text-muted-foreground">
					{error.message || "An unexpected error occurred."}
				</p>
				{error.digest && (
					<p className="text-xs text-muted-foreground font-mono">
						Error ID: {error.digest}
					</p>
				)}
				<div className="flex items-center justify-center gap-3 pt-2">
					<Button variant="outline" onClick={reset}>
						Try Again
					</Button>
					<Button asChild>
						<Link href={backUrl}>Back to Project</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
