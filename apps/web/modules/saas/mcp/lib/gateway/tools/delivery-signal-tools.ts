import { ORPCError } from "@orpc/server";
import { getDeliverySignalSourceConfiguration } from "@repo/api/modules/projects/lib/delivery-signal-sources";
import {
	deliverySignalErrorCode,
	getDeliverySignal,
	listDeliverySignals,
	requireDeliverySignalScopes,
} from "@repo/api/modules/projects/lib/delivery-signals";
import { FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { ZodError } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function deliverySignalScopeRefusal(
	name: string,
	session: GatewaySession,
) {
	if (session.credential === "session") {
		return null;
	}
	try {
		requireDeliverySignalScopes(
			session.scopes,
			name === "fabric_get_delivery_signal_sources",
		);
		return null;
	} catch (error) {
		return errorResult(
			error instanceof Error
				? error.message
				: "Required read scopes are missing.",
			{ code: "INSUFFICIENT_SCOPE" },
		);
	}
}
export function createDeliverySignalTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS) {
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
			const refusal = deliverySignalScopeRefusal(
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
				const result =
					definition.name === "fabric_list_delivery_signals"
						? await listDeliverySignals(actor, args)
						: definition.name === "fabric_get_delivery_signal"
							? await getDeliverySignal(actor, args)
							: await getDeliverySignalSourceConfiguration(
									actor,
									args,
								);
				return jsonResult(result);
			} catch (error) {
				if (error instanceof ZodError) {
					return errorResult("Invalid project history request.", {
						code: "BAD_REQUEST",
					});
				}
				if (error instanceof ORPCError) {
					return errorResult(error.message, {
						code: deliverySignalErrorCode(error),
					});
				}
				return errorResult(
					"Project history is temporarily unavailable.",
					{ code: "UNAVAILABLE" },
				);
			}
		});
	}
	const family = toolFamily(
		FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS,
		handlers,
	);
	for (const definition of FABRIC_DELIVERY_SIGNAL_TOOL_DEFINITIONS) {
		family.scopes[definition.name].exact = true;
		family.scopes[definition.name].additionalScopes = [
			"features:read",
			...(definition.name === "fabric_get_delivery_signal_sources"
				? ["integrations:read"]
				: []),
		];
	}
	return family;
}
