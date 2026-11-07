import { ORPCError } from "@orpc/server";
import { agentPreviewSelectionScopePolicy } from "@repo/api/modules/agents/lib/agent-preview-selection-policy";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import {
	compareSchema,
	configureSchema,
	identitySchema,
	listSchema,
	RunQualityError,
	runQualityTargetSchema,
} from "@repo/utils/run-quality-contracts";
import { z } from "zod";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
/** Target-specific names keep discovery scopes honest; all handlers use canonical commands. */
export function createRunQualityTools() {
	const definitions: FabricToolDefinition[] = [];
	const handlers = new Map<string, PlatformToolHandler>();
	for (const targetType of ["AGENT", "WORKFLOW"] as const) {
		const domain = targetType === "AGENT" ? "agents" : "workflows";
		const noun = targetType.toLowerCase();
		const operations = [
			[
				"get_policy",
				"getRunQualityPolicy",
				runQualityTargetSchema,
				false,
				"Inspect automatic checks for future recorded runs.",
			],
			[
				"configure_policy",
				"configureRunQualityPolicy",
				configureSchema,
				true,
				"Save reviewed revision-pinned automatic checks for future runs; never starts business work.",
			],
			[
				"list_assessments",
				"listRunQualityAssessments",
				listSchema,
				false,
				"Page recorded quality assessments separately from execution status.",
			],
			[
				"get_assessment",
				"getRunQualityAssessment",
				identitySchema,
				false,
				"Inspect a retained assessment with current source permissions.",
			],
			[
				"cancel_assessment",
				"cancelRunQualityAssessment",
				identitySchema,
				true,
				"Cancel this assessment only; never cancels or reruns its business execution.",
			],
			[
				"compare_assessments",
				"compareRunQualityAssessments",
				compareSchema,
				false,
				"Compare compatible pinned recorded assessments; no agent or model is invoked.",
			],
		] as const;
		for (const [
			action,
			operation,
			base,
			write,
			description,
		] of operations) {
			const name = `fabric_${noun}_quality_${action}`;
			const scope = `${domain}:${write ? "write" : "read"}`;
			const schema = base.safeExtend({
				targetType: z.literal(targetType),
			});
			const { $schema: _, ...inputSchema } = z.toJSONSchema(schema, {
				io: "input",
			});
			definitions.push({
				name,
				description,
				inputSchema,
				scope,
				annotations: {
					readOnlyHint: !write,
					idempotentHint: !write || action === "cancel_assessment",
				},
				...(write ? { confirm: "always" as const } : {}),
			});
			handlers.set(name, async (args, session) => {
				if (
					!session.organizationId ||
					session.projectId ||
					session.pinnedProjectId ||
					session.pageProjectId ||
					session.credential === "service"
				) {
					return errorResult(
						"Quality checks require a member organization connection.",
						{ code: "FORBIDDEN" },
					);
				}
				for (const required of [
					`${domain}:read`,
					...(write ? [`${domain}:write`] : []),
				]) {
					if (
						session.credential !== "session" &&
						!session.scopes.includes(required) &&
						!session.scopes.includes("*")
					) {
						return errorResult(
							`This operation requires ${required}.`,
							{ code: "INSUFFICIENT_SCOPE" },
						);
					}
				}
				if (
					new TextEncoder().encode(JSON.stringify(args)).byteLength >
					128 * 1024
				) {
					return errorResult("Quality input exceeds 128 KiB.", {
						code: "BAD_REQUEST",
					});
				}
				const input = schema.safeParse(args);
				if (!input.success) {
					return errorResult(
						"Use the declared quality-check schema; target type must match the selected tool.",
						{ code: "BAD_REQUEST" },
					);
				}
				try {
					const commands = await import(
						"@repo/api/modules/run-quality/lib/commands"
					);
					return jsonResult(
						await commands[operation](
							{
								userId: session.userId,
								organizationId: session.organizationId,
							},
							input.data,
							session.credential === "session"
								? undefined
								: agentPreviewSelectionScopePolicy(
										session.scopes,
									),
						),
					);
				} catch (error) {
					if (
						error instanceof ORPCError &&
						error.data &&
						typeof error.data === "object" &&
						"code" in error.data &&
						error.data.code === "INSUFFICIENT_SCOPE"
					) {
						return errorResult(error.message, {
							code: "INSUFFICIENT_SCOPE",
						});
					}
					return error instanceof RunQualityError
						? errorResult(error.message, { code: error.code })
						: errorResult(
								"Assessment state could not be confirmed. Refresh before retrying.",
								{ code: "UNAVAILABLE" },
							);
				}
			});
		}
	}
	const family = toolFamily(definitions, handlers);
	return {
		...family,
		scopes: Object.fromEntries(
			Object.entries(family.scopes).map(([name, scope]) => [
				name,
				{
					...scope,
					exact: true,
					...(scope.kind === "write"
						? {
								additionalScopes: [
									scope.scope.replace(":write", ":read"),
								],
							}
						: {}),
				},
			]),
		),
	};
}
