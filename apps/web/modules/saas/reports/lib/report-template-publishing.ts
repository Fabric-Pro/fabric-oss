/**
 * Who may give a report template which audience, as the Prompt Library does:
 * members keep their templates to themselves, an organization's admins and
 * owners publish to the organization, and platform admins publish to every
 * organization. The API enforces the same rules; these only keep the page
 * from offering a choice the API would refuse.
 */

import type {
	ReportSuiteCapabilities,
	ReportTemplateScope,
} from "./project-report-suite";

export type ReportTemplatePublishTarget = "ORGANIZATION" | "SYSTEM";

type Roles = Pick<
	ReportSuiteCapabilities,
	"isPlatformAdmin" | "isOrganizationAdmin"
>;

const REPORT_TEMPLATE_SCOPE_LABEL: Record<ReportTemplateScope, string> = {
	USER: "Only me",
	ORGANIZATION: "Organization",
	SYSTEM: "All organizations (system)",
};

const SCOPE_ORDER: ReportTemplateScope[] = ["USER", "ORGANIZATION", "SYSTEM"];

/**
 * The scopes the template form offers. A new template is the author's own
 * ("Only me") unless an organization admin or owner shares it with the
 * organization, or a platform admin makes it a system template. An existing
 * template keeps its scope (publishing widens it), so editing lists it too.
 */
export function reportTemplateScopeOptions({
	inOrganization,
	roles,
	canCreateSystemTemplates,
	currentScope,
}: {
	inOrganization: boolean;
	roles: Roles | undefined;
	/** Platform admins, while the report suite lets them change system templates. */
	canCreateSystemTemplates: boolean;
	/** The scope of the template being edited; undefined for a new one. */
	currentScope?: ReportTemplateScope;
}): { value: ReportTemplateScope; label: string }[] {
	const allowed = new Set<ReportTemplateScope>(["USER"]);
	if (inOrganization && roles?.isOrganizationAdmin) {
		allowed.add("ORGANIZATION");
	}
	if (canCreateSystemTemplates) {
		allowed.add("SYSTEM");
	}
	if (currentScope) {
		allowed.add(currentScope);
	}
	return SCOPE_ORDER.filter((scope) => allowed.has(scope)).map((scope) => ({
		value: scope,
		label: REPORT_TEMPLATE_SCOPE_LABEL[scope],
	}));
}

/**
 * Where the viewer may publish a template. The author of a personal template
 * made in this organization publishes it to the organization when an admin or
 * owner of it; a platform admin publishes any template that is not a system
 * one to every organization. Publishing cannot be undone: archiving removes a
 * template while the reports made from it keep running.
 */
export function reportTemplatePublishTargets(
	template: {
		scope: ReportTemplateScope;
		userId: string | null;
		organizationId: string | null;
		archivedAt: Date | string | null;
	},
	roles: Roles,
	viewerUserId: string | undefined,
): ReportTemplatePublishTarget[] {
	if (template.archivedAt) {
		return [];
	}
	const targets: ReportTemplatePublishTarget[] = [];
	if (
		template.scope === "USER" &&
		template.organizationId !== null &&
		Boolean(viewerUserId) &&
		template.userId === viewerUserId &&
		roles.isOrganizationAdmin
	) {
		targets.push("ORGANIZATION");
	}
	if (roles.isPlatformAdmin && template.scope !== "SYSTEM") {
		targets.push("SYSTEM");
	}
	return targets;
}

/**
 * A system or public template the catalog leaves out until it works: it is
 * neither a named standard template nor authored by a person (`isGeneric`, see
 * `report-template-catalog`), and no report made from it has completed with
 * records (a run that found nothing proves nothing). Platform admins see these
 * only when they ask for every template.
 */
export function isUnprovenCatalogTemplate(template: {
	scope: ReportTemplateScope;
	isPublic: boolean;
	isGeneric: boolean;
	proven: boolean;
}): boolean {
	return (
		(template.scope === "SYSTEM" || template.isPublic) &&
		!template.isGeneric &&
		!template.proven
	);
}
