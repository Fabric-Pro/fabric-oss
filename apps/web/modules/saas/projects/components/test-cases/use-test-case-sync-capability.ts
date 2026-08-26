"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

/** The native test-case sync capability the push controls read. */
export type TestCaseSyncCapability = {
	/** Whether cases can be pushed to the connected tool's native test cases. */
	canPush: boolean;
	/** Ready-to-render "not supported" copy for a disabled push control. */
	unsupportedCopy: string;
};

/**
 * Whether the connected PM tool holds NATIVE test cases — gates the per-case
 * "Sync now" push + the Auto-sync toggle. Reads `supportsPush` from the
 * capabilities probe, which already requires a native test-case entity (Azure
 * DevOps, or a Jira Xray/Zephyr / GitLab test-case connection), NOT merely
 * generic work-item CRUD. Defaults to `false` while loading / on error so the
 * flow stays opt-IN.
 */
export function useTestCaseSyncCapability(
	projectId: string,
): TestCaseSyncCapability {
	const t = useTranslations("projects.testCases");
	const query = useQuery({
		...orpc.projects.testCases.sync.pmCapabilities.queryOptions({
			input: { projectId },
		}),
		staleTime: 5 * 60_000,
		retry: false,
	});
	const caps = query.data?.capabilities ?? null;
	return {
		canPush: caps?.supportsPush ?? false,
		unsupportedCopy: t("sync.pushUnsupported"),
	};
}
