/**
 * Pure rules behind a project's Reports tab: which sub-tab opens first and
 * which template controls a viewer is shown. The API enforces the same rules;
 * these only keep the page from offering an action the API would refuse.
 */

export type ProjectReportsTab = "instances" | "templates";

/**
 * A project that already has reports opens on them; an empty one opens on
 * the templates it can start from. `null` while the count is still loading,
 * so the caller renders nothing rather than flashing the wrong tab.
 */
export function pickDefaultProjectReportsTab(
	instanceTotal: number | undefined,
): ProjectReportsTab | null {
	if (instanceTotal === undefined) {
		return null;
	}
	return instanceTotal > 0 ? "instances" : "templates";
}

export type ReportTemplateScope = "SYSTEM" | "ORGANIZATION" | "USER";

export type ReportSuiteCapabilities = {
	isPlatformAdmin: boolean;
	isOrganizationAdmin: boolean;
	/** `null` when no project was named. */
	canEditProjectReports: boolean | null;
};

/**
 * Whether the viewer may edit, archive or unarchive a template: SYSTEM
 * templates belong to platform admins, ORGANIZATION templates to the
 * organization's admins and owners, USER templates to their author.
 */
export function canManageReportTemplate(
	template: { scope: ReportTemplateScope; userId: string | null },
	capabilities: ReportSuiteCapabilities,
	viewerUserId: string | undefined,
): boolean {
	switch (template.scope) {
		case "SYSTEM":
			return capabilities.isPlatformAdmin;
		case "ORGANIZATION":
			return capabilities.isOrganizationAdmin;
		case "USER":
			return Boolean(viewerUserId) && template.userId === viewerUserId;
		default: {
			const unreachable: never = template.scope;
			return unreachable;
		}
	}
}

/** "New template" is offered to the admins who can publish one, when they may edit this project's reports. */
export function canCreateReportTemplate(
	capabilities: ReportSuiteCapabilities,
): boolean {
	return (
		(capabilities.isPlatformAdmin || capabilities.isOrganizationAdmin) &&
		capabilities.canEditProjectReports !== false
	);
}
