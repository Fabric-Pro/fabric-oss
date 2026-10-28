import { db, hasOrganizationTie, hasProjectAccess } from "@repo/database";

import { resolveEffectiveProjectPermissions } from "./effective-project-permissions";
/** Run ownership is checked by the caller; controls retain live membership checks. */
export async function canControlChatRun(input: {
	userId: string;
	organizationId: string;
	projectId?: string;
	action: "observe" | "reattach" | "approve" | "cancel";
}): Promise<boolean> {
	const { userId, organizationId, projectId, action } = input;
	if (action !== "observe") {
		const member = await db.member.findFirst({
			where: { userId, organizationId },
			select: { role: true },
		});
		if (!member) {
			return false;
		}
	}
	if (projectId) {
		if (!(await hasProjectAccess(projectId, userId, organizationId))) {
			return false;
		}
		const effective = await resolveEffectiveProjectPermissions(
			projectId,
			userId,
		);
		return effective?.organizationId === organizationId;
	}
	return (
		action !== "observe" ||
		(await hasOrganizationTie(userId, organizationId))
	);
}
