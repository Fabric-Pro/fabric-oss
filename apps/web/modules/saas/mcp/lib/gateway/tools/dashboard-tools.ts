import { FABRIC_DASHBOARD_TOOL_DEFINITIONS } from "@repo/temporal/fabric-dashboard-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import { scopeSatisfied } from "../tool-scope";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createDashboardTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_DASHBOARD_TOOL_DEFINITIONS) {
		handlers.set(definition.name, async (args, session) => {
			if (!session.organizationId) {
				return errorResult("An organization connection is required.", {
					code: "FORBIDDEN",
				});
			}
			const write = !definition.annotations.readOnlyHint;
			if (
				session.credential !== "session" &&
				!scopeSatisfied(
					session.scopes,
					{
						scope: definition.scope,
						kind: write ? "write" : "read",
					},
					session.credential,
				)
			) {
				return errorResult(
					`Curated feedback requires the declared ${definition.scope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			try {
				const {
					curatedFeedbackInputSchema,
					listCuratedFeedbackCommand,
					recordCuratedFeedbackCommand,
				} = await import(
					"@repo/api/modules/dashboard/lib/curated-feedback-commands"
				);
				const actor = {
					userId: session.userId,
					organizationId: session.organizationId,
				};
				return jsonResult(
					definition.name === "fabric_list_curated_feedback"
						? await listCuratedFeedbackCommand(actor)
						: await recordCuratedFeedbackCommand(
								actor,
								curatedFeedbackInputSchema.parse(args),
							),
				);
			} catch (error) {
				return errorResult(
					error instanceof Error
						? error.message
						: "Curated feedback could not be saved. Check the card key and action.",
					{ code: "BAD_REQUEST" },
				);
			}
		});
	}
	return toolFamily(FABRIC_DASHBOARD_TOOL_DEFINITIONS, handlers);
}
