interface ProviderWriteLockClient {
	$queryRaw: (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => Promise<unknown>;
}

type ProviderWriteScope =
	| { type: "organization"; id: string }
	| { type: "user"; id: string }
	| { type: "catalog-maintenance" };

/** Acquire before other statements in a provider/preference write transaction. */
export async function lockTenantProviderConnections(
	tx: ProviderWriteLockClient,
	scope: ProviderWriteScope,
): Promise<void> {
	if (scope.type === "organization") {
		await tx.$queryRaw`SELECT id FROM "cloud_provider_config" WHERE "organizationId" = ${scope.id} ORDER BY id FOR NO KEY UPDATE`;
	} else if (scope.type === "user") {
		await tx.$queryRaw`SELECT id FROM "user_cloud_provider_config" WHERE "userId" = ${scope.id} ORDER BY id FOR NO KEY UPDATE`;
	} else {
		// Catalog retirement repoints both preference tables across tenants.
		// Take organization rows, then personal rows, before those writes;
		// each tenant's rows retain the same id order as request writers.
		await tx.$queryRaw`SELECT id FROM "cloud_provider_config" ORDER BY id FOR NO KEY UPDATE`;
		await tx.$queryRaw`SELECT id FROM "user_cloud_provider_config" ORDER BY id FOR NO KEY UPDATE`;
	}
}
