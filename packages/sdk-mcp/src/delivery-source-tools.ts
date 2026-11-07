import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Structural SDK contract: authorization remains in the canonical server commands. */
export interface DeliverySourceClient {
	listDeliverySources?(projectId: string): Promise<unknown>;
	testDeliverySource?(
		projectId: string,
		options: { integrationId: string; channelId: string },
	): Promise<unknown>;
	configureDeliverySource?(
		projectId: string,
		options: {
			integrationId: string;
			channelId: string;
			requestId: string;
			retentionDays?: 7 | 30;
		},
	): Promise<unknown>;
	pauseDeliverySource?(
		projectId: string,
		watchId: string,
		options: { requestId: string; expectedVersion: number },
	): Promise<unknown>;
	resumeDeliverySource?(
		projectId: string,
		watchId: string,
		options: { requestId: string; expectedVersion: number },
	): Promise<unknown>;
	disconnectDeliverySource?(
		projectId: string,
		watchId: string,
		options: { requestId: string; expectedVersion: number },
	): Promise<unknown>;
	startDeliverySourceCapture?(
		projectId: string,
		watchId: string,
		options: {
			requestId: string;
			expectedVersion: number;
			mode?: "RECENT" | "CONTINUE" | "BACKFILL";
			window?: { start: string; end: string };
		},
	): Promise<unknown>;
	getDeliverySourceCapture?(
		projectId: string,
		watchId: string,
	): Promise<unknown>;
	cancelDeliverySourceCapture?(
		projectId: string,
		watchId: string,
		options: { requestId: string },
	): Promise<unknown>;
	listDeliverySourceObservations?(
		projectId: string,
		watchId: string,
		options?: { limit?: number; cursor?: string },
	): Promise<unknown>;
	getDeliverySourceEvidence?(
		projectId: string,
		watchId: string,
		observationId: string,
	): Promise<unknown>;
}
const methods = [
	"listDeliverySources",
	"testDeliverySource",
	"configureDeliverySource",
	"pauseDeliverySource",
	"resumeDeliverySource",
	"disconnectDeliverySource",
	"startDeliverySourceCapture",
	"getDeliverySourceCapture",
	"cancelDeliverySourceCapture",
	"listDeliverySourceObservations",
	"getDeliverySourceEvidence",
] as const;
const id = z.string().trim().min(1).max(200);
const base = z.strictObject({ projectId: id });
const watch = base.extend({ watchId: id });
const mutation = watch.extend({
	requestId: z.uuid(),
	expectedVersion: z.number().int().positive(),
});
const selection = base.extend({ integrationId: id, channelId: id });
const schemas = {
	list: base,
	inspect: selection,
	configure: selection.extend({
		requestId: z.uuid(),
		retentionDays: z.union([z.literal(7), z.literal(30)]).default(7),
	}),
	pause: mutation,
	resume: mutation,
	disconnect: mutation,
	capture: mutation
		.extend({
			mode: z.enum(["RECENT", "CONTINUE", "BACKFILL"]).default("RECENT"),
			window: z
				.strictObject({
					start: z.iso.datetime(),
					end: z.iso.datetime(),
				})
				.optional(),
		})
		.refine(
			(a) => (a.mode === "BACKFILL") === (a.window !== undefined),
			"Only BACKFILL requires an explicit window.",
		),
	status: watch,
	cancel: watch.extend({ requestId: z.uuid() }),
	observations: watch.extend({
		limit: z.number().int().min(1).max(50).default(20),
		cursor: z.string().max(4096).optional(),
	}),
	evidence: watch.extend({ observationId: id }),
};
function complete(
	client: DeliverySourceClient | undefined,
): client is Required<DeliverySourceClient> {
	return (
		client !== undefined &&
		methods.every((method) => typeof client[method] === "function")
	);
}
export function registerDeliverySourceTools(
	server: McpServer,
	client: DeliverySourceClient | undefined,
) {
	if (!complete(client)) {
		return;
	}
	for (const op of Object.keys(schemas) as (keyof typeof schemas)[]) {
		const write = [
			"configure",
			"pause",
			"resume",
			"disconnect",
			"capture",
			"cancel",
		].includes(op);
		server.registerTool(
			`fabric_delivery_source_${op}`,
			{
				description: `${op} your private Slack source capture. Current credential scopes, owner, project and source access are checked by Fabric. Capture supports RECENT, CONTINUE or BACKFILL with an explicit past window of at most seven days within 90 days. Preserve requestId and input after uncertainty. No source writes or automatic monitoring.`,
				inputSchema: schemas[op],
				annotations: {
					readOnlyHint: !write,
					destructiveHint: op === "disconnect",
					idempotentHint: true,
				},
				_meta: write ? { "fabric/confirm": true } : {},
			},
			async (args: unknown) => {
				try {
					// Per-operation parsing narrows the discriminated SDK call; unknown authority fields are refused.
					let data: unknown;
					switch (op) {
						case "list": {
							const a = schemas.list.parse(args);
							data = await client.listDeliverySources(
								a.projectId,
							);
							break;
						}
						case "inspect": {
							const { projectId, ...a } =
								schemas.inspect.parse(args);
							data = await client.testDeliverySource(
								projectId,
								a,
							);
							break;
						}
						case "configure": {
							const { projectId, ...a } =
								schemas.configure.parse(args);
							data = await client.configureDeliverySource(
								projectId,
								a,
							);
							break;
						}
						case "pause":
						case "resume":
						case "disconnect": {
							const { projectId, watchId, ...a } =
								schemas[op].parse(args);
							const method =
								op === "pause"
									? "pauseDeliverySource"
									: op === "resume"
										? "resumeDeliverySource"
										: "disconnectDeliverySource";
							data = await client[method](projectId, watchId, a);
							break;
						}
						case "capture": {
							const { projectId, watchId, ...a } =
								schemas.capture.parse(args);
							data = await client.startDeliverySourceCapture(
								projectId,
								watchId,
								a,
							);
							break;
						}
						case "status": {
							const a = schemas.status.parse(args);
							data = await client.getDeliverySourceCapture(
								a.projectId,
								a.watchId,
							);
							break;
						}
						case "cancel": {
							const { projectId, watchId, ...a } =
								schemas.cancel.parse(args);
							data = await client.cancelDeliverySourceCapture(
								projectId,
								watchId,
								a,
							);
							break;
						}
						case "observations": {
							const { projectId, watchId, ...a } =
								schemas.observations.parse(args);
							data = await client.listDeliverySourceObservations(
								projectId,
								watchId,
								a,
							);
							break;
						}
						case "evidence": {
							const a = schemas.evidence.parse(args);
							data = await client.getDeliverySourceEvidence(
								a.projectId,
								a.watchId,
								a.observationId,
							);
							break;
						}
					}
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(data),
							},
						],
						...(data &&
						typeof data === "object" &&
						!Array.isArray(data)
							? {
									structuredContent: data as Record<
										string,
										unknown
									>,
								}
							: {}),
					};
				} catch (error) {
					const code =
						error instanceof z.ZodError
							? "INVALID_INPUT"
							: error &&
									typeof error === "object" &&
									"code" in error &&
									typeof error.code === "string" &&
									/^[A-Z_]{1,80}$/.test(error.code)
								? error.code
								: "PRIVATE_SOURCE_UNAVAILABLE";
					return {
						isError: true,
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									code,
									error: "Private source request unavailable. Check current scopes, project and source access.",
								}),
							},
						],
					};
				}
			},
		);
	}
}
