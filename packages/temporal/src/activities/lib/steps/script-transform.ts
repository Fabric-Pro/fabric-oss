import { canRunOrganizationWorkflows, hasProjectAccess } from "@repo/database";
import { createSandboxClient } from "@repo/sandbox";
import {
	ExecuteCodeRequestSchema,
	jsonByteLength,
	DYNAMIC_CODE_LIMITS,
	ScriptExecutionContextSchema,
} from "@repo/sandbox/dynamic-worker";
import {
	WorkspaceScriptConfigSchema,
	readPublishedScriptConfig,
} from "../../../lib/workspace-script-config";
import type { NodeExecutionResult, StepParams } from "../../types";
import { loadPublishedExecutionConfig } from "../workflow-execution-definition";

export async function executeScriptTransformStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		userId,
		organizationId,
		workflowId,
		executionId,
		nodeId,
		projectId,
	} = params;
	if (!organizationId || !workflowId || !executionId || !nodeId) {
		return {
			success: false,
			error: "Script Transform requires an organization-scoped workflow execution",
		};
	}
	try {
		if (
			!(await canRunOrganizationWorkflows(userId, organizationId)) ||
			(projectId && !(await hasProjectAccess(projectId, userId)))
		) {
			return {
				success: false,
				error: "No permission to run this workflow",
			};
		}
		const scope = {
			executionId,
			workflowId,
			userId,
			organizationId,
			projectId: projectId ?? null,
		};
		const { config, execution } = await loadPublishedExecutionConfig({
			scope,
			nodeId,
			nodeConfig: params.nodeConfig,
			readConfig: readPublishedScriptConfig,
			parseConfig: (value) => WorkspaceScriptConfigSchema.parse(value),
		});
		const { inputKeys, ...codeConfig } = config;
		const inputs = inputKeys
			? Object.fromEntries(
					inputKeys.map((key): [string, unknown] => {
						if (!Object.hasOwn(params.inputs, key)) {
							throw new Error(
								`Script input key not found: ${key}`,
							);
						}
						return [key, params.inputs[key]];
					}),
				)
			: params.inputs;
		if (jsonByteLength(inputs) > DYNAMIC_CODE_LIMITS.inputBytes) {
			return { success: false, error: "Script inputs exceed 64 KiB" };
		}
		const request = ExecuteCodeRequestSchema.parse({
			...codeConfig,
			inputs,
			execution: ScriptExecutionContextSchema.parse({
				executionId: execution.id,
				workflowId: execution.workflowId,
				version: execution.version,
				triggerType: execution.triggerType,
			}),
		});
		const result = await createSandboxClient().executeCode(
			userId,
			organizationId,
			request,
		);
		if (result.error) {
			return {
				success: false,
				error: result.error,
				output: { logs: result.logs },
			};
		}
		const value = result.results?.[0];
		if (!value || value.type !== "json") {
			return { success: false, error: "Script must return a JSON value" };
		}
		return {
			success: true,
			output: { result: value.json, logs: result.logs },
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Script execution failed",
		};
	}
}
