/**
 * The schedule a report instance may inherit from its template, scoped so a tenant
 * only ever inherits from a template IT owns — never a SYSTEM/public template owned
 * by another tenant. Single source of truth, reused by the API
 * inheritance helper, the update-time inherit re-seed, and the reconcile post-filter.
 * Returns the template's raw schedule when inheritance applies, else `undefined`.
 */
export function ownerScopedTemplateSchedule(
	template: {
		scope: string;
		userId: string | null;
		organizationId: string | null;
		schedule: unknown;
	},
	instanceUserId: string,
	instanceOrganizationId: string | null,
): unknown | undefined {
	if (template.schedule == null) {
		return undefined;
	}
	if (template.scope === "USER") {
		return template.userId === instanceUserId
			? template.schedule
			: undefined;
	}
	if (template.scope === "ORGANIZATION") {
		return template.organizationId != null &&
			template.organizationId === instanceOrganizationId
			? template.schedule
			: undefined;
	}
	return undefined; // SYSTEM / any other scope → never inherit cross-tenant.
}
