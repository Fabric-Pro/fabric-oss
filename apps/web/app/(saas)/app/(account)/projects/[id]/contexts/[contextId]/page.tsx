/**
 * Project Context content-viewer page (personal / account context).
 *
 * Server component: resolves session + params, fetches the context row via the
 * tenant-XOR-safe `getContextById` (tenant XOR + projectId IDOR guard enforced
 * inside the helper), then branches on `row.type`:
 *  - LINK              → `UrlSourcePageView` (re-fetched via `getUrlSourceContext`).
 *  - MEETING_TRANSCRIPT → `MeetingTranscriptPageView` (read-only transcript reader).
 *  - anything else      → redirect back to the project's contexts list.
 *
 * A missing / cross-tenant / cross-project row resolves to `null` (the IDOR
 * guard) → redirect. See spec 2026-06-23-meeting-transcript-viewer §5.3.
 */

import { getContextById, getUrlSourceContext } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { MeetingTranscriptPageView } from "@saas/projects/components/MeetingTranscriptPageView";
import { UrlSourcePageView } from "@saas/projects/components/UrlSourcePageView";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string; contextId: string }>;
	searchParams: Promise<{ back?: string }>;
};

export default async function PersonalContextViewerPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	const { id: projectId, contextId } = await params;
	const { back } = await searchParams;
	// `?back=meeting-digest` (the digest's "Open full transcript" link) returns
	// to the digest; everything else to the Context tab.
	const backTab = back === "meeting-digest" ? "meeting-digest" : "context";
	const backHref = `/app/projects/${projectId}?tab=${backTab}`;

	// Resolve the row via the tenant-XOR-safe getter to determine its type.
	// Cross-tenant / cross-project / missing rows resolve to null → redirect.
	const context = await getContextById(contextId, projectId, {
		userId: session.user.id,
		organizationId: null,
	});

	if (!context) {
		redirect(backHref);
	}

	if (context.type === "MEETING_TRANSCRIPT") {
		const metadata =
			(context.metadata as Record<string, unknown> | null) ?? {};
		const meetingSubject =
			typeof metadata.meetingSubject === "string"
				? metadata.meetingSubject
				: null;
		const meetingDate =
			typeof metadata.meetingDate === "string"
				? metadata.meetingDate
				: null;
		const speakerNames = Array.isArray(metadata.speakerNames)
			? metadata.speakerNames.filter(
					(name): name is string => typeof name === "string",
				)
			: [];
		const wasSummarized = metadata.wasSummarized === true;

		return (
			<>
				<TopRightControls />
				<MeetingTranscriptPageView
					transcript={{
						id: context.id,
						projectId: context.projectId,
						projectName: context.project?.name ?? "Project",
						meetingSubject,
						meetingDate,
						speakerNames,
						wasSummarized,
						content: context.content ?? "",
						syncedAt: context.createdAt.toISOString(),
					}}
					backHref={backHref}
				/>
			</>
		);
	}

	if (context.type !== "LINK") {
		redirect(backHref);
	}

	const row = await getUrlSourceContext({
		contextId,
		projectId,
		userId: session.user.id,
		organizationId: null,
	});

	if (!row || row.type !== "LINK" || !row.sourceUrl) {
		redirect(backHref);
	}

	const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
	const scraperProvider =
		typeof metadata.scraperProvider === "string"
			? metadata.scraperProvider
			: null;

	return (
		<>
			<TopRightControls />
			<UrlSourcePageView
				context={{
					id: row.id,
					projectId: row.projectId,
					projectName: row.project?.name ?? "Project",
					sourceUrl: row.sourceUrl,
					sourceTitle: row.sourceTitle ?? null,
					urlScope: row.urlScope ?? null,
					urlMaxPages: row.urlMaxPages ?? null,
					urlRefreshMode: row.urlRefreshMode ?? null,
					knowledgeBaseSourceCategory:
						row.knowledgeBaseSourceCategory ?? null,
					knowledgeBaseSourceCategoryOther:
						row.knowledgeBaseSourceCategoryOther ?? null,
					urlLastSyncedAt: row.urlLastSyncedAt
						? row.urlLastSyncedAt.toISOString()
						: null,
					urlNextRefreshAt: row.urlNextRefreshAt
						? row.urlNextRefreshAt.toISOString()
						: null,
					extractionStatus: row.extractionStatus ?? null,
					extractionError: row.extractionError ?? null,
					content: row.content ?? "",
					createdAt: row.createdAt.toISOString(),
					updatedAt: row.updatedAt.toISOString(),
					scraperProvider,
					// Total = discovered URL set (PENDING placeholders + finished
					// rows). Indexed / Failed / Pending split out so the
					// Details sidebar's progress table can show every state.
					totalCount: row._count?.urlPages ?? 0,
					indexedCount: row.completedCount ?? 0,
					failedCount: row.failedCount ?? 0,
					pendingCount: row.pendingCount ?? 0,
				}}
				backHref={backHref}
			/>
		</>
	);
}
