import { ORPCError } from "@orpc/server";
import {
	privateTriageCommands,
	requireTriageScopes,
	type TriageActor,
} from "@repo/api/modules/projects/lib/harness-triage-commands";
import {
	type TriageOperation,
	triageCredentialFromFacts,
} from "@repo/api/modules/projects/lib/harness-triage-contracts";
import { FABRIC_TRIAGE_TOOL_DEFINITIONS } from "@repo/temporal/fabric-triage-tool-definitions";
import { ZodError } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

function actorOf(s: GatewaySession): TriageActor | null {
	if (s.credential === "service" || s.pageProjectId !== undefined) {
		return null;
	}
	if (s.credential !== "session" && !s.keyIdentity) {
		return null;
	}
	return {
		userId: s.userId,
		boundProjectId: s.projectId,
		...(s.organizationId
			? { organizationBinding: { organizationId: s.organizationId } }
			: {}),
		credential:
			s.credential === "session"
				? { kind: "SESSION" }
				: triageCredentialFromFacts(
						s.keyIdentity!.credentialKind,
						s.keyIdentity!.credentialId,
						s.scopes,
						s.organizationId,
						s.projectId,
						"mcp",
					),
	};
}
export function triageScopeRefusal(name: string, s: GatewaySession) {
	const actor = actorOf(s);
	if (!actor) {
		return errorResult(
			"Private signal review is unavailable to this runtime.",
			{ code: "FORBIDDEN" },
		);
	}
	try {
		requireTriageScopes(
			actor.credential,
			name.slice("fabric_triage_".length) as TriageOperation,
		);
		return null;
	} catch {
		return errorResult("Required triage scopes are missing.", {
			code: "INSUFFICIENT_SCOPE",
		});
	}
}
export function createHarnessTriageTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_TRIAGE_TOOL_DEFINITIONS) {
		const op = definition.name.slice(
			"fabric_triage_".length,
		) as TriageOperation;
		handlers.set(definition.name, async (args, session) => {
			const refusal = triageScopeRefusal(definition.name, session);
			if (refusal) {
				return refusal;
			}
			if (
				typeof args.projectId === "string" &&
				!sessionMayReachProject(session, args.projectId)
			) {
				return errorResult("Project not found", { code: "NOT_FOUND" });
			}
			const actor = actorOf(session);
			if (!actor) {
				return errorResult(
					"Current credential could not be verified.",
					{ code: "FORBIDDEN" },
				);
			}
			try {
				const data = await privateTriageCommands[op](actor, args);
				return {
					...jsonResult(data),
					structuredContent: { ...data, projectId: args.projectId },
				};
			} catch (error) {
				if (error instanceof ZodError) {
					return errorResult("Invalid private triage request.", {
						code: "INVALID_INPUT",
					});
				}
				if (error instanceof ORPCError) {
					return errorResult(error.message, {
						code:
							(error.data as { code?: string } | undefined)
								?.code ?? error.code,
					});
				}
				return errorResult("Private signal review unavailable.", {
					code: "TRIAGE_UNAVAILABLE",
				});
			}
		});
	}
	return toolFamily(FABRIC_TRIAGE_TOOL_DEFINITIONS, handlers);
}
