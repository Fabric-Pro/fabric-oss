"use client";

import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function RepositoryHeaderBadge({
	branch,
	commitSha,
}: {
	branch: string;
	commitSha: string;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const text = t("publishedBadgeRepository", {
		ref: branch,
		sha7: commitSha.slice(0, 7),
	});
	return (
		<span
			data-testid="instructions-branch-pill"
			title={text}
			className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-0.5 font-medium text-success text-xs"
		>
			<CheckIcon className="size-3 shrink-0" aria-hidden="true" />
			<span className="truncate">{text}</span>
		</span>
	);
}
