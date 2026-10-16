/**
 * A live workflow is one its schedule, webhook and "run now" may start:
 * published, or active from before publishing had its own status. Pure and
 * free of the database client, so the builder's UI, the API and the database
 * queries all ask the same question (`@repo/database` re-exports it).
 */
export function isWorkflowLive(status: string): boolean {
	return status === "PUBLISHED" || status === "ACTIVE";
}
