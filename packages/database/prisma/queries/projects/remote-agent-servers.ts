import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { db } from "../../client";

export interface RemoteAgentTarget {
	name?: string;
	url: string;
	profileId: string;
	connectionId?: string;
	projectId?: string;
	organizationId?: string;
	userId?: string;
}

const publicFields = {
	id: true,
	name: true,
	scope: true,
	userId: true,
	url: true,
	profileId: true,
	isActive: true,
} as const;

export async function listRemoteAgentServers(
	projectId: string,
	userId: string,
) {
	return db.projectRemoteAgentServer.findMany({
		where: {
			projectId,
			isActive: true,
			OR: [{ userId }, { scope: "TEAM" }],
		},
		select: publicFields,
		orderBy: { name: "asc" },
	});
}

export async function getRemoteAgentServerForActor(
	id: string,
	projectId: string,
	userId: string,
) {
	return db.projectRemoteAgentServer.findFirst({
		where: {
			id,
			projectId,
			isActive: true,
			OR: [{ userId }, { scope: "TEAM" }],
		},
		select: publicFields,
	});
}

export async function createRemoteAgentServer(input: {
	projectId: string;
	userId: string;
	name: string;
	scope: "PRIVATE" | "TEAM";
	url: string;
	profileId: string;
	secret: string;
}) {
	const { secret, ...data } = input;
	return db.projectRemoteAgentServer.create({
		data: { ...data, encryptedSecret: encryptApiKey(secret) },
		select: publicFields,
	});
}

/** Connections are immutable: changing endpoint/profile requires a new connection. */
export async function disableRemoteAgentServer(id: string, projectId: string) {
	return db.projectRemoteAgentServer.updateMany({
		where: { id, projectId, isActive: true },
		data: { isActive: false },
	});
}

/** Server-only lookup. Never put this result in API responses or workflow history. */
export async function getRemoteAgentServerSecret(
	target: RemoteAgentTarget,
	requireActive = false,
) {
	if (
		!target.connectionId ||
		!target.projectId ||
		!target.organizationId ||
		!target.userId
	) {
		throw new Error("Remote server binding is incomplete");
	}
	const row = await db.projectRemoteAgentServer.findFirst({
		where: {
			id: target.connectionId,
			projectId: target.projectId,
			project: { organizationId: target.organizationId },
		},
	});
	// Disabled connections remain usable for observing/stopping existing sessions.
	// Admission and continuation independently require an active connection.
	if (
		!row ||
		(requireActive && !row.isActive) ||
		row.url !== target.url ||
		row.profileId !== target.profileId ||
		(row.scope !== "TEAM" && row.userId !== target.userId)
	) {
		throw new Error(
			"Remote server binding changed; recover on the original server",
		);
	}
	return decryptApiKey(row.encryptedSecret);
}
