/**
 * Where QA test results actually come from — and, more usefully, where they do
 * not.
 *
 * The first acceptance criterion for pipeline results is written as "GIVEN a project with a
 * connected PM tool (ADO)", and it is not satisfied as worded: results are
 * pulled from the **code-repository** integration (Settings ▸ Development),
 * never from the PM-tool (MCP) connection. Azure DevOps results do arrive, but
 * through the ADO *code-repo* integration, not the ADO *PM* connection — two
 * different integrations that a customer reasonably reads as one.
 *
 * The requirement was rescoped rather than met (2026-07-27): Fabric does not
 * build a PM-tool test-management fetcher. What it owes instead is FR6's honest
 * half — a project whose PM tool cannot return runs should be TOLD so, rather
 * than shown an empty list it has no way to interpret. An empty state that does
 * not distinguish "nothing connected" from "the thing you connected cannot do
 * this" is how a working product looks broken.
 *
 * Resolution is deliberately from STORED configuration, not an MCP capability
 * probe. This renders on a settings page load; a network round trip to a
 * customer's MCP server to decide the wording of an empty state would be a poor
 * trade, and the tool's identity is enough to say the true thing.
 */

import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
} from "@repo/database";
import {
	pmDetectedTypeDisplayName,
	pmServerKeyToDetectedType,
} from "@repo/utils";

/**
 * The display name of the project's connected PM tool, or null when there is
 * none.
 *
 * Uses the same `projectManagementMcpServerId` → server key → detected type →
 * display name chain the PM capabilities endpoint uses, so the name shown here
 * cannot disagree with the name shown everywhere else.
 */
export async function resolveProjectPmToolLabel(
	projectId: string,
): Promise<string | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { projectManagementMcpServerId: true },
	});
	const serverId = project?.projectManagementMcpServerId;
	if (!serverId) {
		return null;
	}

	// The id is either a real MCPServer row or a sentinel carrying the key
	// directly (a default tool the customer never explicitly installed).
	const key = isPmServerIdKeySentinel(serverId)
		? readPmServerIdKeySentinel(serverId)
		: ((
				await db.mCPServer.findUnique({
					where: { id: serverId },
					select: { key: true },
				})
			)?.key ?? null);

	return pmDetectedTypeDisplayName(pmServerKeyToDetectedType(key)) ?? null;
}

/**
 * The sentence to show when a project has NO connected repository, so no CI
 * results can arrive.
 *
 * Two different situations, and conflating them is the bug: a project with
 * nothing connected needs to connect something, while a project whose PM tool
 * is connected has already done what it thinks was asked and needs to be told
 * that is a different connection.
 */
export function describeMissingResultSource(
	pmToolLabel: string | null,
): string {
	if (!pmToolLabel) {
		return "No repositories are connected to this project yet. Connect one under Settings ▸ Development to pull CI test results.";
	}
	return `${pmToolLabel} is connected as a project-management tool, which cannot return test runs — Fabric reads results from your CI pipeline. Connect the repository your tests run in under Settings ▸ Development.`;
}
