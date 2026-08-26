"use client";

/**
 * Client-side wrapper for DailyBriefPage when rendered inside the
 * ProjectDetails tab system (rather than as a standalone server page).
 *
 * Fetches the brief via oRPC on mount, then delegates rendering to
 * DailyBriefPage. Matches how sibling tabs (Weave, Pipeline, etc.) self-fetch.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { DailyBriefPage } from "./DailyBriefPage";

export interface DailyBriefTabProps {
	projectId: string;
	organizationId: string | null;
	/**
	 * Project capability/role info, already fetched by the parent
	 * (`ProjectDetails`'s `orpc.projects.get` query) — used to gate
	 * release-notes exclusion management. Mirrors ReleaseNotesList's editor
	 * gate: capability first (covers org admins without an explicit project
	 * role), role as fallback. Omitted/undefined resolves to non-editor.
	 */
	project?: {
		canEditSettings?: boolean;
		userRole?: string | null;
	};
}

// Must match DEFAULT_DAILY_BRIEF_WINDOW in @repo/database. Duplicated as a
// literal here because importing the runtime value from @repo/database would
// pull the Prisma/pg client into the client bundle.
type SupportedWindow = "LAST_24H" | "LAST_7D" | "LAST_2W";
const DEFAULT_DAILY_BRIEF_WINDOW: SupportedWindow = "LAST_7D";

export function DailyBriefTab({
	projectId,
	organizationId,
	project,
}: DailyBriefTabProps) {
	const [timeWindow, setTimeWindow] = useState<SupportedWindow>(
		DEFAULT_DAILY_BRIEF_WINDOW,
	);
	const queryClient = useQueryClient();
	const queryKey = ["dailyBrief.get", projectId, organizationId, timeWindow];

	const { data, isLoading, isError } = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.dailyBrief.get({
				projectId,
				organizationId,
				timeWindow,
			}),
		// Poll while generating so the UI transitions to READY without a manual refresh.
		refetchInterval: (query) =>
			query.state.data?.brief?.status === "GENERATING" ? 3000 : false,
	});

	const canEditExclusions =
		project?.canEditSettings === true ||
		project?.userRole === "owner" ||
		project?.userRole === "project_admin";

	// The exclusion list is editor-only server-side (PROJECT_SETTINGS_EDIT) —
	// `enabled` skips the call entirely for readers rather than relying on the
	// server to reject it.
	const { data: exclusionsData } = useQuery({
		...orpc.dailyBrief.exclusions.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: canEditExclusions,
	});

	// Invalidate on successful regenerate/hide/unhide so the tab's cache picks
	// up the new GENERATING row (refetchInterval begins polling) and the
	// Manage-hidden list reflects the change. router.refresh() alone only
	// refreshes server components, not client-side TanStack caches. The
	// exclusions key is derived from the SAME queryOptions helper used above
	// so it can never drift out of sync with the actual cache key.
	const onRegenerated = useCallback(() => {
		queryClient.invalidateQueries({ queryKey });
		queryClient.invalidateQueries({
			queryKey: orpc.dailyBrief.exclusions.list.queryOptions({
				input: { projectId, organizationId },
			}).queryKey,
		});
	}, [queryClient, queryKey, projectId, organizationId]);

	// Error takes precedence: with no data and isError=true, the previous order
	// would loop on the loading message forever.
	if (isError) {
		return (
			<div className="flex min-h-[40vh] items-center justify-center text-destructive">
				<span className="text-sm">Could not load Daily Brief.</span>
			</div>
		);
	}

	if (isLoading || !data) {
		return (
			<div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
				<span className="text-sm">Loading Daily Brief…</span>
			</div>
		);
	}

	return (
		<DailyBriefPage
			projectId={projectId}
			organizationId={organizationId}
			timeWindow={timeWindow}
			onTimeWindowChange={setTimeWindow}
			onRegenerated={onRegenerated}
			brief={data.brief?.content ?? null}
			status={data.brief?.status ?? null}
			briefId={data.brief?.id ?? null}
			generatedAt={data.brief?.generatedAt ?? null}
			cursor={data.cursor}
			progress={data.progress}
			errorMessage={data.brief?.errorMessage ?? null}
			canEditExclusions={canEditExclusions}
			exclusions={canEditExclusions ? (exclusionsData ?? []) : []}
		/>
	);
}
