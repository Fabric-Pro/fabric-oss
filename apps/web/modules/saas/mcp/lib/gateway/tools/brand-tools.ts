import type { RecordAuditFromRequestInput } from "@repo/api/lib/audit";
import {
	artifactBrandReadSchema,
	clientBrandSaveSchema,
	companyBrandSaveSchema,
	proposalStyleReadSchema,
	proposalStyleSaveSchema,
} from "@repo/api/modules/branding/lib/brand-contracts";
import { FABRIC_BRAND_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import { scopeSatisfied } from "../tool-scope";
import { type PlatformToolHandler, toolFamily } from "./tool-family";
export function createBrandTools() {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const definition of FABRIC_BRAND_TOOL_DEFINITIONS) {
		handlers.set(definition.name, async (args, session) => {
			const companyWrite =
				definition.name === "fabric_update_company_brand";
			const write = !definition.annotations.readOnlyHint;
			if (!session.organizationId) {
				return errorResult("An organization connection is required.", {
					code: "FORBIDDEN",
				});
			}
			if (
				companyWrite &&
				(session.credential === "service" ||
					session.projectId ||
					session.pinnedProjectId ||
					session.pageProjectId)
			) {
				return errorResult(
					"Company branding requires an organization connection for its administrator. Use the company Brand kit in Portal.",
					{ code: "FORBIDDEN" },
				);
			}
			const projectId =
				args.projectId ??
				session.projectId ??
				session.pinnedProjectId ??
				session.pageProjectId;
			if (
				projectId !== undefined &&
				(typeof projectId !== "string" ||
					!sessionMayReachProject(session, projectId))
			) {
				return errorResult("Project not found", { code: "NOT_FOUND" });
			}
			const requiredScope =
				definition.name === "fabric_get_artifact_brand" && !projectId
					? "orgs:read"
					: definition.scope;
			if (
				session.credential !== "session" &&
				!(companyWrite
					? session.scopes.includes("orgs:write") ||
						session.scopes.includes("*")
					: scopeSatisfied(
							session.scopes,
							{
								scope: requiredScope,
								kind: write ? "write" : "read",
							},
							session.credential,
						))
			) {
				return errorResult(
					`Branding requires the declared ${requiredScope} scope.`,
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			try {
				const {
					getArtifactBrandCommand,
					saveCompanyBrandCommand,
					saveClientBrandCommand,
				} = await import(
					"@repo/api/modules/branding/lib/brand-commands"
				);
				const actor = {
					userId: session.userId,
					organizationId: session.organizationId,
				};
				const audit = async (event: RecordAuditFromRequestInput) => {
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
						metadata: { ...event.metadata, via: "mcp" },
					});
				};
				if (
					definition.name === "fabric_get_proposal_style" ||
					definition.name === "fabric_update_proposal_style"
				) {
					const {
						getProposalStyleCommand,
						saveProposalStyleCommand,
					} = await import(
						"@repo/api/modules/branding/lib/proposal-style-commands"
					);
					const result =
						definition.name === "fabric_get_proposal_style"
							? await getProposalStyleCommand(
									actor,
									proposalStyleReadSchema.parse({
										...args,
										projectId,
									}),
								)
							: await saveProposalStyleCommand(
									actor,
									proposalStyleSaveSchema.parse({
										...args,
										projectId,
									}),
									audit,
								);
					return jsonResult(result);
				}
				const result = companyWrite
					? await saveCompanyBrandCommand(
							actor,
							companyBrandSaveSchema.parse(args),
							audit,
						)
					: definition.name === "fabric_update_client_brand"
						? await saveClientBrandCommand(
								actor,
								clientBrandSaveSchema.parse({
									...args,
									projectId,
								}),
								audit,
							)
						: await getArtifactBrandCommand(
								actor,
								artifactBrandReadSchema.parse({
									...args,
									...(projectId ? { projectId } : {}),
								}),
							);
				return jsonResult(result);
			} catch (error) {
				const code =
					error && typeof error === "object" && "code" in error
						? String(error.code)
						: "BAD_REQUEST";
				return errorResult(
					error instanceof Error &&
						["FORBIDDEN", "NOT_FOUND", "CONFLICT"].includes(code)
						? error.message
						: "Branding could not be confirmed. Check the schema and read current branding before retrying.",
					{ code },
				);
			}
		});
	}
	return toolFamily(FABRIC_BRAND_TOOL_DEFINITIONS, handlers);
}
