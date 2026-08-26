/**
 * Visibility decision for the "Shared with me" section on the projects page.
 *
 * The section is a PERSONAL-workspace-only surface: it lists org projects
 * where the user is a project-scoped guest (accepted ProjectMember, no org
 * membership), so it must never render inside an organization workspace —
 * and it disappears entirely when the user has no shared projects, rather
 * than showing an empty-state shell.
 *
 * Kept as a pure function so the decision logic is unit-testable without
 * rendering the full `ProjectsList` component.
 */
export function shouldShowSharedProjects(options: {
	/**
	 * Tenant context: `null` in the personal workspace (`/app/...`), an
	 * organization id in an org workspace (`/app/{slug}/...`). Mirrors
	 * `useOrganizationContext().organizationId`.
	 */
	organizationId: string | null;
	/** Number of guest projects returned by `projects.listGuest`. */
	guestProjectCount: number;
}): boolean {
	return options.organizationId === null && options.guestProjectCount > 0;
}
