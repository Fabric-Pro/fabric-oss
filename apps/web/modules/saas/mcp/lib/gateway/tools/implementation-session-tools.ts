import { ORPCError } from "@orpc/client";
import type { CodingRunActor } from "@repo/api/modules/coding-runs/lib/commands-access";
import type { ImplementationAudit } from "@repo/api/modules/coding-runs/lib/implementation-commands";
import { FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createImplementationSessionTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS) {
		handlers.set(definition.name, async (args, session) => {
			if (
				session.credential !== "session" &&
				!session.scopes.includes(definition.scope) &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					`This operation requires ${definition.scope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			if (
				!session.organizationId ||
				typeof args.projectId !== "string" ||
				!sessionMayReachProject(session, args.projectId)
			) {
				return errorResult("Project not found or access denied.", {
					code: "NOT_FOUND",
				});
			}
			const actor: CodingRunActor = {
				userId: session.userId,
				organizationId: session.organizationId,
			};
			const audit = async (event: Parameters<ImplementationAudit>[0]) => {
				const { recordAudit } = await import("@repo/database");
				return recordAudit({
					...event,
					actor: {
						type:
							session.credential === "session"
								? "user"
								: session.credential === "oauth"
									? "agent"
									: "api_key",
						userId: session.userId,
					},
					metadata: { ...(event.metadata ?? {}), via: "mcp" },
				});
			};
			try {
				const {
					cancelImplementationSession,
					followUpImplementationSession,
					getImplementationMessages,
					getImplementationSession,
					listImplementationSessions,
					startImplementationSession,
				} = await import(
					"@repo/api/modules/coding-runs/lib/implementation-commands"
				);
				const operation = {
					fabric_list_implementation_sessions:
						listImplementationSessions,
					fabric_get_implementation_session: getImplementationSession,
					fabric_start_implementation_session: (actor, input) =>
						startImplementationSession(actor, input, audit),
					fabric_cancel_implementation_session: (actor, input) =>
						cancelImplementationSession(actor, input, audit),
					fabric_get_implementation_messages:
						getImplementationMessages,
				} as Record<
					string,
					(actor: CodingRunActor, input: unknown) => Promise<unknown>
				>;
				return jsonResult(
					definition.name ===
						"fabric_follow_up_implementation_session"
						? await followUpImplementationSession(
								actor,
								args,
								audit,
							)
						: await operation[definition.name](actor, args),
				);
			} catch (error) {
				if (error instanceof z.ZodError) {
					return errorResult(
						"Use the declared implementation-session schema.",
						{ code: "BAD_REQUEST" },
					);
				}
				if (
					error instanceof ORPCError &&
					[
						"FORBIDDEN",
						"NOT_FOUND",
						"CONFLICT",
						"BAD_REQUEST",
						"PRECONDITION_FAILED",
					].includes(error.code)
				) {
					return errorResult(error.message, { code: error.code });
				}
				return errorResult(
					"The implementation outcome could not be confirmed. Inspect the existing session and reuse the same request identity before retrying.",
					{ code: "UNAVAILABLE" },
				);
			}
		});
	}
	const family = toolFamily(FABRIC_IMPLEMENTATION_TOOL_DEFINITIONS, handlers);
	for (const scope of Object.values(family.scopes)) {
		scope.exact = true;
	}
	return family;
}
