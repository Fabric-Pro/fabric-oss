/** Trusted context used by the same report handlers in Portal and transport commands. */
export interface ReportCommandContext {
	headers?: Headers;
	user: { id: string; name?: string | null; email?: string };
	session: { activeOrganizationId?: string | null };
}
