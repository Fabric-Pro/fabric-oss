import { db } from "../client";

const DEFAULT_TERMINAL_STATUSES = ["Closed", "Done", "Removed"];

/**
 * If the project is PM-connected and its terminal-status list is empty, seed
 * it with the built-in defaults. Idempotent and best-effort: callers invoke
 * this from every PM-connect write path (create/update/draft-activation).
 * Never throws — a seeding failure must not block the surrounding write.
 */
export async function seedTerminalStatusesIfEmpty(
	projectId: string,
): Promise<void> {
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				projectManagementMcpConfigId: true,
				projectManagementMcpServerId: true,
				pmTerminalStatuses: true,
			},
		});
		if (!project) {
			return;
		}
		// A project is "PM-connected" when EITHER the pinned config id OR the
		// server-type id is set.
		const isConnected = Boolean(
			project.projectManagementMcpConfigId ||
				project.projectManagementMcpServerId,
		);
		const isEmpty = (project.pmTerminalStatuses ?? []).length === 0;
		if (!isConnected || !isEmpty) {
			return;
		}

		await db.project.update({
			where: { id: projectId },
			data: { pmTerminalStatuses: DEFAULT_TERMINAL_STATUSES },
		});
	} catch {
		// best-effort — never block the calling write
	}
}
