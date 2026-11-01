import { ORPCError } from "@orpc/client";
import { db, getRemoteAgentServerForActor } from "@repo/database";

export function remoteServerConnectionId(
	metadata: unknown,
): string | undefined {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("executionTarget" in metadata)
	) {
		return;
	}
	const target = metadata.executionTarget;
	return target &&
		typeof target === "object" &&
		"connectionId" in target &&
		typeof target.connectionId === "string"
		? target.connectionId
		: undefined;
}

/** Project permission is checked by the caller before resolving a connection. */
export async function requireRemoteServerAccess(input: {
	id: string;
	projectId: string;
	userId: string;
	allowDisabled?: boolean;
}) {
	const server = input.allowDisabled
		? await db.projectRemoteAgentServer.findFirst({
				where: {
					id: input.id,
					projectId: input.projectId,
					OR: [{ userId: input.userId }, { scope: "TEAM" }],
				},
				select: {
					id: true,
					name: true,
					scope: true,
					userId: true,
					url: true,
					profileId: true,
					isActive: true,
				},
			})
		: await getRemoteAgentServerForActor(
				input.id,
				input.projectId,
				input.userId,
			);
	if (!server) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"This remote server is unavailable or belongs to another developer.",
		});
	}
	return server;
}
