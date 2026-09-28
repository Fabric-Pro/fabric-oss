"use client";

import { Button } from "@ui/components/button";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

/**
 * The Glossy page's own error boundary: without it a crash here falls through
 * to the document editor's, which names the wrong page.
 */
export default function GlossyEditionError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const t = useTranslations("projects.glossy.page");
	const params = useParams();
	const organizationSlug = params?.organizationSlug as string | undefined;
	const projectId = params?.id as string | undefined;
	const documentId = params?.documentId as string | undefined;

	useEffect(() => {
		console.error("[GlossyEdition] Client-side error:", error);
	}, [error]);

	const backUrl =
		organizationSlug && projectId && documentId
			? `/app/${organizationSlug}/projects/${projectId}/documents/${documentId}`
			: "/app";

	return (
		<div className="flex min-h-[50vh] items-center justify-center p-6">
			<div className="max-w-md space-y-4 text-center">
				<AlertTriangle
					className="mx-auto h-10 w-10 text-destructive"
					aria-hidden="true"
				/>
				<h2 className="font-semibold text-lg">{t("loadFailed")}</h2>
				{error.digest && (
					<p className="font-mono text-muted-foreground text-xs">
						{error.digest}
					</p>
				)}
				<div className="flex justify-center gap-2">
					<Button variant="outline" onClick={reset}>
						{t("retryLoad")}
					</Button>
					<Button asChild>
						<Link href={backUrl}>{t("backToDocument")}</Link>
					</Button>
				</div>
			</div>
		</div>
	);
}
