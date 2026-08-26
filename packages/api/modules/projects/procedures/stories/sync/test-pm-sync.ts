import { ORPCError } from "@orpc/client";
import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Test PM sync by creating a single work item in the configured project.
 * Helps verify: MCP connection, project/container ID, and PAT permissions.
 */
export const testPMSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/test-pm-sync",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Test PM sync connection",
		description:
			"Create a test work item in the configured PM tool to verify the connection works",
	})
	.input(
		z.object({
			projectId: z.string(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			externalId: z.string().optional(),
			externalUrl: z.string().optional(),
			message: z.string(),
			pmToolType: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		if (!project.projectManagementContainerId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Project management integration not configured",
			});
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		// GitLab REST fallback: project is wired to `gitlab-official` but the
		// calling user has no resolvable MCPConfig — either because the tier
		// probe found the instance isn't MCP-capable (fresh REST projects) or
		// because an older project still carries a stale
		// `projectManagementMcpConfigId` from when GitLab went through MCP. The
		// MCP path below can't serve these users, so create the test issue
		// through the same REST adapter the pull/push sync uses. Gated on
		// `!userMcpConfig` alone. Mirrors the detection in get-pm-capabilities.
		if (!userMcpConfig && project.projectManagementMcpServerId) {
			// Resolve the project's PM server key. For a real catalog row we
			// look it up by id; for a `key:` sentinel (PR #1205, seed drift
			// fallback) we read the key directly without touching the DB.
			let serverKey: string | null = null;
			if (isPmServerIdKeySentinel(project.projectManagementMcpServerId)) {
				serverKey = readPmServerIdKeySentinel(
					project.projectManagementMcpServerId,
				);
			} else {
				const server = await db.mCPServer.findUnique({
					where: { id: project.projectManagementMcpServerId },
					select: { key: true },
				});
				serverKey = server?.key ?? null;
			}
			if (serverKey === "gitlab-official") {
				const tenantFilter = project.organizationId
					? {
							organizationId: project.organizationId,
							userId: user.id,
						}
					: { organizationId: null, userId: user.id };
				const integration = await db.workflowIntegration.findFirst({
					where: {
						...tenantFilter,
						provider: "GITLAB",
						isActive: true,
					},
					select: { id: true },
				});
				if (integration) {
					const {
						resolveGitLabPMSource,
						createGitLabIssueFromStory,
					} = await import("@repo/integrations/gitlab/pm-adapter");
					const source = await resolveGitLabPMSource({
						userId: user.id,
						organizationId: project.organizationId ?? null,
						projectId: project.id,
					});
					if (!source) {
						throw new ORPCError("BAD_REQUEST", {
							message:
								"Could not resolve your GitLab connection. Reconnect GitLab in Settings.",
						});
					}
					try {
						const created = await createGitLabIssueFromStory({
							source,
							gitlabProjectId:
								project.projectManagementContainerId,
							payload: {
								title: "Test work item from Fabric",
								description:
									"This work item was created to verify the Fabric ↔ GitLab connection.",
							},
							userId: user.id,
							organizationId: project.organizationId ?? null,
						});
						return {
							success: true,
							externalId: created.externalId,
							externalUrl: created.externalUrl ?? undefined,
							message: created.externalId
								? `Test work item created (ID: ${created.externalId})`
								: "Test work item created",
							pmToolType: "gitlab-rest",
						};
					} catch (err) {
						const reason =
							err instanceof Error ? err.message : String(err);
						logger.warn("pm.test_sync.failed", {
							projectId: project.id,
							pmTool: "gitlab-rest",
							reason,
						});
						// Soft-failure audit: the audit-error middleware only
						// logs thrown errors. This branch returns
						// `{success:false}` (HTTP 200) by contract, so the
						// middleware never sees it. Emit explicitly so the
						// test-sync outcome stays visible in audit-log
						// queries.
						recordAuditFromRequest(context, {
							action: "story.pm_pushed",
							category: "story",
							outcome: "failure",
							severity: "warning",
							organizationId: project.organizationId ?? null,
							projectId: project.id,
							resource: {
								type: "project",
								id: project.id,
								name: null,
							},
							metadata: {
								op: "test-pm-sync",
								pmTool: "gitlab-rest",
								reason,
							},
						});
						return {
							success: false,
							message: `Failed to create test work item: ${reason}`,
						};
					}
				}
			}
		}

		if (!userMcpConfig) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"You have not connected your account to the project management tool. Configure in Settings.",
			});
		}

		const { discoverPMToolCapabilities, executeMcpTool } = await import(
			"@repo/temporal"
		);
		const additionalContext = (project.projectManagementAdditionalContext ??
			{}) as Record<string, string>;

		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId: userMcpConfig.id,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!capabilities?.hasPMCapabilities || !capabilities.taskCreation) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"PM tool does not support work item creation. Check your MCP configuration.",
			});
		}

		const createTool = capabilities.taskCreation as {
			toolName: string;
			containerParam: string;
			titleParam?: string;
			descriptionParam?: string;
			fieldsBased?: {
				titleKey: string;
				descriptionKey: string;
				workItemTypeParam: string;
				fieldsParam: string;
			};
		};

		const title = "Test work item from Fabric";
		const description =
			"This work item was created to verify the Fabric ↔ Azure DevOps connection.";
		const containerId = project.projectManagementContainerId;

		let createArgs: Record<string, unknown>;

		if (createTool.fieldsBased) {
			// Azure DevOps MCP expects fields as array: [{ name, value, format? }]
			const fieldsArray: Array<{
				name: string;
				value: string;
				format?: "Html" | "Markdown";
			}> = [
				{ name: createTool.fieldsBased.titleKey, value: title },
				{
					name: createTool.fieldsBased.descriptionKey,
					value: description,
					format: "Markdown",
				},
			];
			// Azure DevOps requires backslashes for AreaPath/IterationPath (TF401347)
			if (additionalContext.areaPath) {
				fieldsArray.push({
					name: "System.AreaPath",
					value: additionalContext.areaPath
						.trim()
						.replace(/\//g, "\\"),
				});
			}
			if (additionalContext.iterationPath) {
				fieldsArray.push({
					name: "System.IterationPath",
					value: additionalContext.iterationPath
						.trim()
						.replace(/\//g, "\\"),
				});
			}
			const workItemType = additionalContext.workItemType ?? "User Story";
			createArgs = {
				[createTool.containerParam]: containerId,
				[createTool.fieldsBased.workItemTypeParam]: workItemType,
				[createTool.fieldsBased.fieldsParam]: fieldsArray,
			};
		} else {
			createArgs = {
				[createTool.containerParam]: containerId,
				// biome-ignore lint/style/noNonNullAssertion: titleParam exists for create tools
				[createTool.titleParam!]: title,
			};
			if (createTool.descriptionParam) {
				createArgs[createTool.descriptionParam] = description;
			}
			// Pass through only known tool-agnostic extras. Spreading
			// additionalContext leaks ADO-only keys (workItemType, areaPath,
			// iterationPath) into strict provider schemas like GitLab's
			// create_issue, which rejects unknown keys.
			if (typeof additionalContext.account_slug === "string") {
				createArgs.account_slug = additionalContext.account_slug;
			}
		}

		const result = await executeMcpTool({
			toolName: createTool.toolName,
			args: createArgs,
			userId: user.id,
			organizationId: project.organizationId || undefined,
			mcpConfigId: userMcpConfig.id,
		});

		if (!result.success) {
			let errorDetail = "Unknown error";
			if (typeof result.output === "object" && result.output !== null) {
				const out = result.output as Record<string, unknown>;
				// executeMcpTool returns { error: string } on exception
				if (typeof out.error === "string" && out.error) {
					errorDetail = out.error;
				} else if (Array.isArray(out.content)) {
					// MCP SDK format: { content: [{ type: "text", text: "..." }] }
					const textItem = (
						out.content as Array<{ type?: string; text?: string }>
					).find((c) => c.type === "text");
					if (textItem?.text) {
						errorDetail = textItem.text;
					}
				}
			}
			const pmToolLabel = capabilities.detectedType ?? "unknown";
			logger.warn("pm.test_sync.failed", {
				projectId: project.id,
				pmTool: pmToolLabel,
				reason: errorDetail,
			});
			// Soft-failure audit (parity with the GitLab REST catch above).
			recordAuditFromRequest(context, {
				action: "story.pm_pushed",
				category: "story",
				outcome: "failure",
				severity: "warning",
				organizationId: project.organizationId ?? null,
				projectId: project.id,
				resource: {
					type: "project",
					id: project.id,
					name: null,
				},
				metadata: {
					op: "test-pm-sync",
					pmTool: pmToolLabel,
					reason: errorDetail,
				},
			});
			return {
				success: false,
				message: `Failed to create test work item: ${errorDetail}`,
			};
		}

		// Parse response for externalId and URL
		let externalId: string | undefined;
		let externalUrl: string | undefined;

		if (typeof result.output === "object" && result.output !== null) {
			const data = result.output as Record<string, unknown>;
			if (Array.isArray(data.content)) {
				const textItem = (
					data.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					try {
						const parsed = JSON.parse(textItem.text) as Record<
							string,
							unknown
						>;
						externalId = String(parsed.id ?? parsed.card_id ?? "");
						const links = parsed._links as
							| { web?: { href?: string } }
							| undefined;
						externalUrl =
							links?.web?.href ??
							String(
								parsed.url ??
									parsed.webUrl ??
									parsed.link ??
									"",
							);
					} catch {
						// ignore parse errors
					}
				}
			}
		}

		return {
			success: true,
			externalId,
			externalUrl,
			message:
				!externalUrl && externalId
					? `Test work item created (ID: ${externalId})`
					: "Test work item created",
			pmToolType: capabilities.detectedType ?? undefined,
		};
	});
