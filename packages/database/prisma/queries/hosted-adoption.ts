import { db } from "../client";
import { FABRIC_SYSTEM_USER_ID } from "./projects/comments";

/** Platform-wide registered footprint for the instance-admin report. */
export async function getHostedAdoptionCounts() {
	const [organizations, projects, users] = await Promise.all([
		db.organization.count({ where: { deletedAt: null } }),
		db.project.count({
			where: {
				deletedAt: null,
				OR: [
					{ organizationId: null },
					{ organization: { deletedAt: null } },
				],
			},
		}),
		db.user.count({ where: { id: { not: FABRIC_SYSTEM_USER_ID } } }),
	]);
	return { organizations, projects, users };
}
