import { createHash } from "node:crypto";
import {
	type getTemporalClient,
	getTemporalConfig,
} from "@repo/temporal/client";
import { z } from "zod";
import { triageModelPin } from "./harness-triage-contracts";
export const triageExecutionBinding = z.strictObject({
	namespace: z.string().min(1),
	namespaceId: z.string().min(1),
	routingDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const triageStoredModel = z.strictObject({
	pin: triageModelPin,
	execution: triageExecutionBinding,
});
export async function resolveTriageExecutionBinding(
	client: Awaited<ReturnType<typeof getTemporalClient>>,
) {
	const namespace = client.options.namespace;
	const described = await client.connection.withDeadline(
		Date.now() + 5000,
		() =>
			client.connection.workflowService.describeNamespace({ namespace }),
	);
	const namespaceId = described.namespaceInfo?.id;
	if (!namespaceId) {
		throw Error("TRIAGE_NATIVE_BINDING_UNAVAILABLE");
	}
	return triageExecutionBinding.parse({
		namespace,
		namespaceId,
		routingDigest: createHash("sha256")
			.update(
				JSON.stringify([
					getTemporalConfig().address,
					namespace,
					namespaceId,
				]),
			)
			.digest("hex"),
	});
}
