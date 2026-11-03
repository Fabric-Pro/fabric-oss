import { getCanonicalNameForProviderModelId } from "@repo/database";

/** Apply the same tenant, connection, model and task scopes as model calls. */
export async function assertGatewayRerankUsageLimits(scope: {
	userId?: string;
	organizationId?: string | null;
	projectId?: string | null;
	providerConfigId?: string | null;
	providerModelId: string;
}): Promise<string | null> {
	if (!scope.organizationId || !scope.userId) {
		throw new Error("Gateway reranking requires an organization and user");
	}
	// Loading payments registers the usage recorder; defer that until dispatch.
	const { assertWithinAiUsageLimits } = await import("@repo/payments");
	const modelCanonicalName = await getCanonicalNameForProviderModelId(
		scope.providerModelId,
		"VERCEL_GATEWAY",
	);
	await assertWithinAiUsageLimits({
		userId: scope.userId,
		organizationId: scope.organizationId,
		projectId: scope.projectId ?? null,
		providerConfigId: scope.providerConfigId ?? null,
		modelCanonicalName,
		taskType: "EMBEDDING",
	});
	return modelCanonicalName;
}
