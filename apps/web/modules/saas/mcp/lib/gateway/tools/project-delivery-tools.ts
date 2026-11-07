import { ORPCError } from "@orpc/server";
import {
	getProjectDeliverySnapshot,
	projectDeliveryInput,
} from "@repo/api/modules/projects/lib/delivery-snapshot";
import { FABRIC_PROJECT_DELIVERY_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createProjectDeliveryTools() {
	const definitions = FABRIC_PROJECT_DELIVERY_TOOL_DEFINITIONS;
	const handler: PlatformToolHandler = async (args, session) => {
		const parsed = projectDeliveryInput.safeParse(args);
		if (!parsed.success) {
			return errorResult("Provide one projectId.", {
				code: "BAD_REQUEST",
			});
		}
		if (
			session.credential !== "session" &&
			!session.scopes.includes("projects:read") &&
			!session.scopes.includes("*")
		) {
			return errorResult(
				"Project delivery requires projects:read scope.",
				{ code: "INSUFFICIENT_SCOPE" },
			);
		}
		if (
			!session.organizationId ||
			!sessionMayReachProject(session, parsed.data.projectId)
		) {
			return errorResult("Project not found or access denied.", {
				code: "NOT_FOUND",
			});
		}
		try {
			return jsonResult(
				await getProjectDeliverySnapshot(
					{
						userId: session.userId,
						organizationId: session.organizationId,
					},
					parsed.data,
				),
			);
		} catch (error) {
			if (error instanceof ORPCError) {
				return errorResult(error.message, { code: error.code });
			}
			return errorResult("Project delivery is temporarily unavailable.", {
				code: "UNAVAILABLE",
			});
		}
	};
	const family = toolFamily(
		definitions,
		new Map([["fabric_get_project_delivery", handler]]),
	);
	family.scopes.fabric_get_project_delivery.exact = true;
	return family;
}
