/**
 * Tenant-Isolated Storage Path Builder
 *
 * Centralizes S3/R2 object key construction so every path automatically
 * encodes the tenant boundary (organizationId OR userId — XOR, never both).
 *
 * Security principle (F-099 — post-breach credential and isolation audit):
 * - Every object key MUST begin with an owner prefix derived from the tenant
 *   context. This ensures that even if bucket-level access controls are
 *   misconfigured, individual objects cannot be enumerated across tenants
 *   from the key structure alone.
 * - Organization context: prefix = organizationId
 * - Personal context: prefix = userId
 * - The XOR is intentional — personal files must never appear under an org
 *   prefix and vice versa.
 *
 * Usage:
 *   import { buildTenantStoragePath, buildProjectStoragePath } from "@repo/storage";
 *
 *   // Chat document (tenant-isolated):
 *   const key = buildTenantStoragePath({
 *     organizationId: chat.organizationId,
 *     userId: chat.userId,
 *     sub: `${chatId}/${documentId}.pdf`,
 *   });
 *   // → "org_abc/chat_xyz/doc_1234.pdf"  (org context)
 *   // → "usr_abc/chat_xyz/doc_1234.pdf"  (personal context)
 */

/** XOR tenant owner prefix — organization wins over user. */
export function tenantOwnerPrefix(
	organizationId: string | null | undefined,
	userId: string,
): string {
	return organizationId || userId;
}

/**
 * Build a tenant-isolated storage path.
 *
 * The resulting key starts with `{ownerPrefix}/{sub}`.
 *
 * @param opts.organizationId - Organization ID (org context) or null/undefined (personal)
 * @param opts.userId - User ID (always required as fallback owner)
 * @param opts.sub - Sub-path after the owner prefix (must not start with `/`)
 */
export function buildTenantStoragePath(opts: {
	organizationId: string | null | undefined;
	userId: string;
	sub: string;
}): string {
	const prefix = tenantOwnerPrefix(opts.organizationId, opts.userId);
	return `${prefix}/${opts.sub}`;
}

/**
 * Build a project-scoped storage path.
 *
 * Project files are scoped by projectId — tenant isolation is enforced at
 * the database authorization layer (hasProjectAccess / requireProjectPermission)
 * rather than in the key itself. The projectId prefix still prevents
 * cross-project key collisions.
 *
 * @param opts.projectId - Project ID
 * @param opts.sub - Sub-path after the project prefix
 */
export function buildProjectStoragePath(opts: {
	projectId: string;
	sub: string;
}): string {
	return `projects/${opts.projectId}/${opts.sub}`;
}

/**
 * Validate that a storage key is owned by the given tenant.
 *
 * Used as a server-side guard when a client-supplied key is presented for
 * download or deletion — prevents tenants from accessing each other's objects
 * by guessing or manipulating keys.
 *
 * Returns `true` if the key starts with the expected tenant owner prefix.
 *
 * @param key - The S3 object key to check
 * @param organizationId - Organization ID (org context) or null/undefined (personal)
 * @param userId - User ID
 */
export function isTenantOwnedKey(
	key: string,
	organizationId: string | null | undefined,
	userId: string,
): boolean {
	const expectedPrefix = tenantOwnerPrefix(organizationId, userId);
	return key === expectedPrefix || key.startsWith(`${expectedPrefix}/`);
}

/**
 * Assert that a storage key is owned by the given tenant.
 * Throws if the key does not belong to the tenant.
 *
 * Use this in API procedures before generating presigned download/delete URLs
 * for client-supplied keys.
 *
 * @throws Error with a generic message (safe to surface to client) if the key
 *         does not match the tenant.
 */
export function assertTenantOwnedKey(
	key: string,
	organizationId: string | null | undefined,
	userId: string,
): void {
	if (!isTenantOwnedKey(key, organizationId, userId)) {
		// Generic message — do not reveal the expected prefix or the key
		// to prevent oracle attacks.
		throw new Error("Storage object not found or access denied");
	}
}
