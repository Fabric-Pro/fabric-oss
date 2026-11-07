import { ORPCError } from "@orpc/server";
import { deliverySignalErrorCode } from "@repo/api/modules/projects/lib/delivery-signals";
import {
	type DeliverySourceOperation,
	deliverySourceEvidence,
	deliverySourceInspection,
	deliverySourceList,
	deliverySourceObservationPage,
	deliverySourceRequiredScopes,
	deliverySourceRun,
	deliverySourceWatch,
} from "@repo/api/modules/projects/lib/delivery-source-contracts";
import { FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { ZodError } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function deliverySourceScopeRefusal(
	name: string,
	session: GatewaySession,
) {
	if (session.credential === "session") {
		return null;
	}
	const operation = name.slice(
		"fabric_delivery_source_".length,
	) as DeliverySourceOperation;
	if (
		session.scopes.includes("*") ||
		deliverySourceRequiredScopes(operation).every((scope) =>
			session.scopes.includes(scope),
		)
	) {
		return null;
	}
	return errorResult("Required source scopes are missing.", {
		code: "INSUFFICIENT_SCOPE",
	});
}

export function createDeliverySourceTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS) {
		const operation = definition.name.slice(
			"fabric_delivery_source_".length,
		) as DeliverySourceOperation;
		handlers.set(definition.name, async (args, session) => {
			if (
				session.credential === "service" ||
				session.pageProjectId !== undefined
			) {
				return errorResult(
					"This operation is not available to this runtime.",
					{ code: "FORBIDDEN" },
				);
			}
			const refusal = deliverySourceScopeRefusal(
				definition.name,
				session,
			);
			if (refusal) {
				return refusal;
			}
			if (
				typeof args.projectId === "string" &&
				!sessionMayReachProject(session, args.projectId)
			) {
				return errorResult("Project not found", { code: "NOT_FOUND" });
			}
			const actor = {
				userId: session.userId,
				boundProjectId: session.projectId,
				...(session.credential === "organization-key" ||
				session.credential === "oauth"
					? {
							organizationBinding: {
								organizationId: session.organizationId,
							},
						}
					: {}),
			};
			try {
				const commands = await import(
					"@repo/api/modules/projects/lib/delivery-source-commands"
				);
				switch (operation) {
					case "list":
						return jsonResult(
							deliverySourceList.parse(
								await commands.listDeliverySourceWatches(
									actor,
									args,
								),
							),
						);
					case "inspect":
						return jsonResult(
							deliverySourceInspection.parse(
								await commands.inspectDeliverySource(
									actor,
									args,
								),
							),
						);
					case "configure":
						return jsonResult(
							deliverySourceWatch.parse(
								await commands.configureDeliverySource(
									actor,
									args,
								),
							),
						);
					case "pause":
					case "resume":
					case "disconnect": {
						// The action is fixed by the tool, never client supplied.
						if ("action" in args) {
							throw new ZodError([]);
						}
						return jsonResult(
							deliverySourceWatch.parse(
								await commands.updateDeliverySourceState(
									actor,
									{
										...args,
										action: operation.toUpperCase(),
									},
								),
							),
						);
					}
					case "capture":
						return jsonResult(
							deliverySourceRun.parse(
								await commands.startDeliverySourceCapture(
									actor,
									args,
								),
							),
						);
					case "status":
						return jsonResult(
							deliverySourceRun.parse(
								await commands.getDeliverySourceCaptureStatus(
									actor,
									args,
								),
							),
						);
					case "cancel":
						return jsonResult(
							deliverySourceRun.parse(
								await commands.cancelDeliverySourceCapture(
									actor,
									args,
								),
							),
						);
					case "observations":
						return jsonResult(
							deliverySourceObservationPage.parse(
								await commands.listDeliverySourceObservations(
									actor,
									args,
								),
							),
						);
					case "evidence":
						return jsonResult(
							deliverySourceEvidence.parse(
								await commands.getDeliverySourceEvidence(
									actor,
									args,
								),
							),
						);
				}
			} catch (error) {
				if (error instanceof ZodError) {
					return errorResult("Invalid private source request.", {
						code: "BAD_REQUEST",
					});
				}
				if (error instanceof ORPCError) {
					return errorResult(
						error.code === "INTERNAL_SERVER_ERROR"
							? "Private sources are temporarily unavailable."
							: error.message,
						{
							code: deliverySignalErrorCode(error),
							status: error.status,
						},
					);
				}
				return errorResult(
					"Private sources are temporarily unavailable.",
					{ code: "UNAVAILABLE" },
				);
			}
		});
	}
	const family = toolFamily(
		FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS,
		handlers,
	);
	for (const definition of FABRIC_DELIVERY_SOURCE_TOOL_DEFINITIONS) {
		const scopes = deliverySourceRequiredScopes(
			definition.name.slice(
				"fabric_delivery_source_".length,
			) as DeliverySourceOperation,
		);
		family.scopes[definition.name].exact = true;
		family.scopes[definition.name].additionalScopes = scopes.slice(1);
	}
	return family;
}
