import { ownerScopedTemplateSchedule } from "@repo/database";

/** @see ownerScopedTemplateSchedule — kept as the API-layer name used by create.ts. */
export function templateScheduleForInheritance(
	template: {
		scope: string;
		userId: string | null;
		organizationId: string | null;
		schedule: unknown;
	},
	instanceUserId: string,
	instanceOrganizationId: string | null,
): unknown | undefined {
	return ownerScopedTemplateSchedule(
		template,
		instanceUserId,
		instanceOrganizationId,
	);
}
