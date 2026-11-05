import { fetchCredentialsByIdAndProviderInTenant } from "@repo/database";
import {
	DatabricksSqlError,
	executeDatabricksSql,
	type DatabricksSqlParameter,
} from "@repo/integrations";
import { z } from "zod";
import type { NodeExecutionResult, StepParams } from "../types";
import { activityCancellationSignal } from "./activity-liveness";
import { interpolateTemplateWithDiagnostics } from "./steps/utils";

const common = z.object({
	integrationId: z.string().min(1).max(128),
	warehouseId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/),
});
const parameter = z.object({
	name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
	type: z.enum([
		"STRING",
		"BOOLEAN",
		"INT",
		"BIGINT",
		"DOUBLE",
		"DATE",
		"TIMESTAMP",
	]),
	value: z.string().max(20000).nullable(),
});
const sqlConfig = common.extend({
	statement: z
		.string()
		.trim()
		.min(1)
		.max(50000)
		.refine(
			(s) => !s.includes("{{"),
			"Use named parameters, not template substitution, in SQL",
		),
	parameters: z.array(parameter).max(50).default([]),
	rowLimit: z.coerce.number().int().min(1).max(1000).default(100),
});
const aiConfig = common.extend({
	endpoint: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
	request: z.string().min(1).max(8192),
});

export async function executeDatabricksStatementStep(
	params: StepParams,
	ai: boolean,
): Promise<NodeExecutionResult> {
	if (!params.organizationId)
		return {
			success: false,
			error: "An organization is required for Databricks workflows.",
		};
	const parsed = ai
		? aiConfig.safeParse(params.nodeConfig)
		: sqlConfig.safeParse(params.nodeConfig);
	if (!parsed.success)
		return {
			success: false,
			error: "Configure a Databricks SQL connection, warehouse, and valid query parameters. SQL source cannot contain template expressions.",
		};
	// Parse the unexpanded source first. Only parameter VALUES may reference upstream outputs.
	const config = parsed.data;
	const credentials = await fetchCredentialsByIdAndProviderInTenant(
		config.integrationId,
		"DATABRICKS_SQL",
		params.userId,
		params.organizationId,
	);
	if (!credentials)
		return {
			success: false,
			error: "The selected Databricks SQL connection is unavailable or no longer shared with you. Select an authorized connection.",
		};
	let statement: string;
	let parameters: DatabricksSqlParameter[];
	let rowLimit: number;
	if ("endpoint" in config) {
		const resolved = interpolateTemplateWithDiagnostics(
			config.request,
			params.inputs,
		);
		if (resolved.unresolved.length)
			return {
				success: false,
				error: "AI request contains unresolved references. Check the earlier step outputs.",
			};
		const request = resolved.text;
		if (request.length > 8192 || !request.trim())
			return {
				success: false,
				error: "AI request must contain 1–8192 characters after resolving variables.",
			};
		statement = `SELECT ai_query('${config.endpoint}', :request, modelParameters => named_struct('max_tokens', 512)) AS response`;
		parameters = [{ name: "request", type: "STRING", value: request }];
		rowLimit = 1;
	} else {
		statement = config.statement;
		const resolved = config.parameters.map((p) => ({
			...p,
			resolved:
				p.value === null
					? { text: null, unresolved: [] }
					: interpolateTemplateWithDiagnostics(
							p.value,
							params.inputs,
						),
		}));
		if (resolved.some((p) => p.resolved.unresolved.length))
			return {
				success: false,
				error: "SQL parameters contain unresolved references. Check the earlier step outputs.",
			};
		parameters = resolved.map((p) => ({
			name: p.name,
			type: p.type,
			value: p.resolved.text,
		}));
		rowLimit = config.rowLimit;
	}
	try {
		const result = await executeDatabricksSql(credentials, {
			warehouseId: config.warehouseId,
			statement,
			parameters,
			rowLimit,
			signal: activityCancellationSignal(),
		});
		return {
			success: true,
			output: {
				statementId: result.statementId,
				workspaceUrl: result.workspaceUrl,
				columns: result.columns,
				rows: result.rows,
				truncated: result.truncated,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof DatabricksSqlError
					? error.message
					: "Databricks SQL could not run. Check the selected connection.",
			...(error instanceof DatabricksSqlError && error.statementId
				? { output: { statementId: error.statementId } }
				: {}),
		};
	}
}
