import { db } from "../../client";

/** A personal deployment has no organization membership to check. */
export async function isDeploymentOwnerCurrentMember(deployment: {
	userId: string;
	organizationId: string | null;
}): Promise<boolean> {
	if (deployment.organizationId === null) {
		return true;
	}
	if (!deployment.userId || !deployment.organizationId) {
		return false;
	}
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: deployment.organizationId,
				userId: deployment.userId,
			},
		},
		select: { id: true },
	});
	return Boolean(member?.id);
}
