import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { remoteServerConnectionId } from "./remote-server-access";

/** A project may share task progress without sharing its developer's private host. */
export async function publicCodingRuns<
	T extends { projectId: string; providerMetadata: unknown },
>(runs: T[], userId: string) {
	const projectIds = [...new Set(runs.map((run) => run.projectId))];
	if (
		(
			await Promise.all(
				projectIds.map((id) => hasProjectAccess(id, userId)),
			)
		).some((access) => !access)
	) {
		throw new ORPCError("NOT_FOUND", { message: "Coding run not found" });
	}
	const ids = runs
		.map((run) => remoteServerConnectionId(run.providerMetadata))
		.filter((id): id is string => !!id);
	if (!ids.length) {
		return runs;
	}
	const visible = await db.projectRemoteAgentServer.findMany({
		where: {
			id: { in: ids },
			projectId: { in: projectIds },
			OR: [{ userId }, { scope: "TEAM" }],
		},
		select: { id: true },
	});
	const visibleIds = new Set(visible.map((row) => row.id));
	return runs.map((run) => {
		const connectionId = remoteServerConnectionId(run.providerMetadata);
		if (!connectionId || visibleIds.has(connectionId)) {
			return run;
		}
		return {
			...run,
			externalUrl: null,
			providerSessionId: null,
			externalStatus: null,
			workingDirectory: null,
			providerMetadata: {
				executionRuntime: "fabric-agent-server",
				privateSession: true,
			},
			events: [],
		};
	});
}
