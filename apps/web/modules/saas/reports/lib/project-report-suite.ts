/**
 * Pure rules behind a project's Reports tab: which sub-tab opens first and
 * which template controls a viewer is shown. The API enforces the same rules;
 * these only keep the page from offering an action the API would refuse.
 */

export type ProjectReportsTab = "instances" | "templates";

/**
 * A viewer who has reports in this project, drafts included, opens on them;
 * anyone else opens on the templates they can start from. `null` while the
 * count is still loading, so the caller renders nothing rather than flashing
 * the wrong tab.
 */
export function pickDefaultProjectReportsTab(
	ownReportTotal: number | undefined,
): ProjectReportsTab | null {
	if (ownReportTotal === undefined) {
		return null;
	}
	return ownReportTotal > 0 ? "instances" : "templates";
}

/** A project's Reports tab, under the organization's base path. */
export function projectReportsHref(
	organizationBasePath: string,
	projectId: string,
): string {
	return `${organizationBasePath}/projects/${encodeURIComponent(projectId)}?tab=reports`;
}

/**
 * A template page opened from a project's Reports tab carries the project,
 * so its back links, its "Use template" and the report it creates stay in
 * that project.
 */
export function withProjectContext(
	path: string,
	projectId: string | null | undefined,
): string {
	return projectId
		? `${path}?projectId=${encodeURIComponent(projectId)}`
		: path;
}

export type ReportTemplateScope = "SYSTEM" | "ORGANIZATION" | "USER";

export type ReportSuiteCapabilities = {
	isPlatformAdmin: boolean;
	isOrganizationAdmin: boolean;
	/** `null` when no project was named. */
	canEditProjectReports: boolean | null;
	/**
	 * Whether the viewer may set the project's report defaults, which an
	 * organization Viewer with an Editor project row may and cannot add reports;
	 * `null` when no project was named.
	 */
	canSetProjectDefaults?: boolean | null;
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

/**
 * Whether a template is listed. Archived templates are listed only to the
 * people who may restore them, so an author finds their own archived personal
 * template while other members never see archived templates they cannot use.
 */
export function isReportTemplateListed(
	template: {
		scope: ReportTemplateScope;
		userId: string | null;
		archivedAt: Date | string | null;
	},
	capabilities: ReportSuiteCapabilities,
	viewerUserId: string | undefined,
): boolean {
	return (
		!template.archivedAt ||
		canManageReportTemplate(template, capabilities, viewerUserId)
	);
}

/**
 * The templates a project's list shows, from a list fetched with archived
 * templates included, and whether the viewer may restore any archived one:
 * the "Show archived templates" switch is offered only then.
 */
export function listedReportTemplates<
	T extends {
		scope: ReportTemplateScope;
		userId: string | null;
		archivedAt: Date | string | null;
	},
>(
	templates: T[],
	capabilities: ReportSuiteCapabilities,
	viewerUserId: string | undefined,
	showArchived: boolean,
): { templates: T[]; hasRestorable: boolean } {
	const listed = templates.filter((template) =>
		isReportTemplateListed(template, capabilities, viewerUserId),
	);
	const hasRestorable = listed.some((template) => template.archivedAt);
	return {
		templates:
			showArchived && hasRestorable
				? listed
				: listed.filter((template) => !template.archivedAt),
		hasRestorable,
	};
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
