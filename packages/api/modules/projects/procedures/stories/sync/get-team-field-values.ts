import { ORPCError } from "@orpc/client";
import { db, resolvePMConfigForUser } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

/**
 * Fetch an Azure DevOps team's configured area paths (its "team field values").
 *
 * Used by the project-settings UI to resolve a team's real default area path
 * when saving PM config. Synthesising `${projectName}\${teamName}` is wrong:
 * that path only exists if the ADO admin ticked "Create area path" when the
 * team was created (TF401347 on push otherwise).
 *
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/work/teamfieldvalues/get
 */
export const getTeamFieldValuesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-team-field-values",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Get ADO team's configured area paths",
		description:
			"Return the team's default area path and configured area path values from Azure DevOps",
	})
	.input(
		z.object({
			projectId: z.string().min(1),
			containerId: z.string().min(1),
			teamId: z.string().min(1),
		}),
	)
	.output(
		z.object({
			defaultArea: z.string().nullable(),
			areaPaths: z.array(z.string()),
			error: z.string().nullable(),
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
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		if (!userMcpConfig) {
			return {
				defaultArea: null,
				areaPaths: [],
				error: "You have not connected your account to the project management tool",
			};
		}

		const isAzureDevOps =
			userMcpConfig.mcpServer?.key === "azure-devops" ||
			userMcpConfig.mcpServer?.command?.includes("azure-devops");

		if (!isAzureDevOps) {
			return {
				defaultArea: null,
				areaPaths: [],
				error: "Team field values are only supported for Azure DevOps",
			};
		}

		if (!userMcpConfig.encryptedApiKey) {
			return {
				defaultArea: null,
				areaPaths: [],
				error: "Azure DevOps connection has no API key (PAT) configured",
			};
		}

		let org =
			Array.isArray(userMcpConfig.commandArgs) &&
			userMcpConfig.commandArgs.length > 0
				? String(userMcpConfig.commandArgs[0]).trim()
				: null;

		if (!org && userMcpConfig.baseUrl) {
			try {
				const url = new URL(userMcpConfig.baseUrl);
				const pathMatch = url.pathname.match(/^\/([^/]+)/);
				if (pathMatch) {
					org = pathMatch[1];
				} else if (url.hostname.endsWith(".visualstudio.com")) {
					org = url.hostname.replace(".visualstudio.com", "");
				}
			} catch {
				// ignore
			}
		}

		if (!org) {
			return {
				defaultArea: null,
				areaPaths: [],
				error: "Azure DevOps organization not found. Configure org in MCP settings.",
			};
		}

		const apiUrl = `https://dev.azure.com/${encodeURIComponent(
			org,
		)}/${encodeURIComponent(input.containerId)}/${encodeURIComponent(
			input.teamId,
		)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`;

		try {
			const pat = decryptApiKey(userMcpConfig.encryptedApiKey);
			const auth = Buffer.from(`:${pat}`).toString("base64");
			const res = await fetch(apiUrl, {
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			});

			if (!res.ok) {
				const body = await res.text();
				return {
					defaultArea: null,
					areaPaths: [],
					error: `Azure DevOps API error (${res.status}): ${body.slice(0, 200)}`,
				};
			}

			const data = (await res.json()) as {
				defaultValue?: string;
				values?: Array<{ value?: string }>;
			};

			const areaPaths = Array.isArray(data.values)
				? data.values
						.map((v) => (v?.value ? String(v.value) : null))
						.filter((v): v is string => !!v)
				: [];

			return {
				defaultArea: data.defaultValue
					? String(data.defaultValue)
					: null,
				areaPaths,
				error: null,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			return {
				defaultArea: null,
				areaPaths: [],
				error: `Failed to fetch team field values: ${msg}`,
			};
		}
	});
