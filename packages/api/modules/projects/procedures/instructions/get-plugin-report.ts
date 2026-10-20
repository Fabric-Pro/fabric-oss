import {
	type PluginEntry,
	type PluginLeftOutReason,
	planPluginFiles,
} from "@fabricorg/sdk";
import {
	getPublishedInstructionSnapshot,
	listInstructionFiles,
	resolveCurrentInstructionSource,
} from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { listDirectRepositoryFilesForApi } from "./repository/direct-query";

/** Left-out files named in one answer; the count says how many there were. */
const PLUGIN_REPORT_MAX_LEFT_OUT = 200;

type PluginReport = {
	state: "ready" | "nothing-published" | "unavailable";
	mode: "UPLOAD" | "REPOSITORY";
	carriedCount: number;
	rulesCount: number;
	leftOutCount: number;
	leftOut: Array<{ path: string; reason: PluginLeftOutReason }>;
	truncated: boolean;
};

function empty(
	state: PluginReport["state"],
	mode: PluginReport["mode"],
): PluginReport {
	return {
		state,
		mode,
		carriedCount: 0,
		rulesCount: 0,
		leftOutCount: 0,
		leftOut: [],
		truncated: false,
	};
}

/**
 * A memory file the other tool uses is not wasted: CLAUDE.md serves Claude
 * Code and AGENTS.md Codex, so a project with both has left nothing out.
 */
function report(
	entries: readonly PluginEntry[],
	mode: PluginReport["mode"],
): PluginReport {
	const plan = planPluginFiles(entries, "claude-code");
	const leftOut = plan.leftOut.filter(
		(entry) => entry.reason !== "always-on-shadowed",
	);
	return {
		state: "ready",
		mode,
		carriedCount: plan.carried.length + (plan.alwaysOn === null ? 0 : 1),
		rulesCount: plan.rules.length,
		leftOutCount: leftOut.length,
		leftOut: leftOut.slice(0, PLUGIN_REPORT_MAX_LEFT_OUT),
		truncated: leftOut.length > PLUGIN_REPORT_MAX_LEFT_OUT,
	};
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Which of the project's PUBLISHED instruction files a coding-tool plugin has
 * no place for, and why, computed here with the mapping the CLI builds the
 * plugin with (`planPluginFiles`), so the Coding Instructions tab shows an
 * admin what is left out without any developer running the CLI.
 *
 *  - A project that reads its repository directly is reported from the
 *    repository listing at the head commit, through the same authorized read
 *    the tab's file tree uses. A listing that is incomplete or refused is
 *    `unavailable`: a report from part of the tree would be wrong.
 *  - Any other project is reported from its published snapshot's files. The
 *    published pointer is unscoped (it lives on the `Project` row), so the
 *    snapshot's organization is compared with the project's host (R11) and a
 *    mismatch is answered as nothing published, like `getPublished`.
 */
export const getPluginReportProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/plugin-report",
		tags: ["Projects", "Instructions"],
		summary:
			"Which published instruction files a coding-tool plugin leaves out",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context, signal }): Promise<PluginReport> => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const { sourceOfTruth } = await resolveCurrentInstructionSource(
			input.projectId,
			organizationId,
		);
		if (sourceOfTruth === "REPOSITORY") {
			const listing = await listDirectRepositoryFilesForApi({
				projectId: input.projectId,
				userId: context.user.id,
				signal,
			});
			if (listing.incomplete || listing.refusal !== null) {
				return empty("unavailable", "REPOSITORY");
			}
			return report(
				listing.files.map((file) => ({
					path: file.path,
					size: file.size,
				})),
				"REPOSITORY",
			);
		}
		const snapshot = await getPublishedInstructionSnapshot(input.projectId);
		if (!snapshot || snapshot.organizationId !== organizationId) {
			return empty("nothing-published", "UPLOAD");
		}
		const files = await listInstructionFiles(snapshot.id, organizationId);
		return report(
			files.map((file) => ({
				path: file.path,
				size: file.size,
				isText: file.isText,
			})),
			"UPLOAD",
		);
	});
