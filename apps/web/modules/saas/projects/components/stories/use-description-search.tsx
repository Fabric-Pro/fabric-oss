import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { buildSearchTokens } from "../../lib/roadmap-filters";

export function useDescriptionSearch(
	projectId: string,
	organizationId: string | null,
	q: string,
	stories: readonly { id: string; updatedAt: Date | string }[] | undefined,
) {
	const needles = useMemo(
		() => [
			...new Set(
				buildSearchTokens(q)
					.flatMap((t) => [t.raw, t.normalized])
					.filter(Boolean),
			),
		],
		[q],
	);
	const skipped = needles.length > 64 || needles.some((n) => n.length > 2000);
	const enabled = needles.length > 0 && !skipped;
	const search = useQuery({
		...orpc.projects.stories.searchDescriptions.queryOptions({
			input: { projectId, organizationId, needles },
		}),
		enabled,
	});
	const fingerprint = useMemo(
		() =>
			JSON.stringify([
				stories?.length ?? 0,
				...(stories ?? []).map((story) => [
					story.id,
					new Date(story.updatedAt).getTime(),
				]),
			]),
		[stories],
	);
	const previousBoard = useRef(fingerprint);
	const { refetch } = search;
	useEffect(() => {
		if (previousBoard.current !== fingerprint) {
			previousBoard.current = fingerprint;
			if (enabled) {
				void refetch();
			}
		}
	}, [fingerprint, enabled, refetch]);
	const matches = useMemo(
		() =>
			new Map(
				(enabled ? (search.data?.matches ?? []) : []).map((m) => [
					m.id,
					m.needles,
				]),
			),
		[enabled, search.data],
	);
	const status = skipped
		? "skipped"
		: enabled && search.data === undefined && search.isFetching
			? "pending"
			: enabled && search.isError && !search.isFetching
				? "failed"
				: null;
	return { matches, status, retry: () => void refetch() };
}

export function DescriptionSearchStatus({
	status,
	retry,
}: Pick<ReturnType<typeof useDescriptionSearch>, "status" | "retry">) {
	const t = useTranslations("projects.stories.roadmapUi");
	if (!status) {
		return null;
	}
	return (
		<output aria-live="polite" className="text-xs text-muted-foreground">
			{t(`descriptionSearch.${status}`)}
			{status === "failed" && (
				<Button variant="link" size="sm" onClick={retry}>
					{t("descriptionSearch.retry")}
				</Button>
			)}
		</output>
	);
}
