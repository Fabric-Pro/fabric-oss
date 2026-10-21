import { getWorkspaceWorkflowRecord } from "@repo/database";
import { WORKSPACE_DATA_READ_NODE_TYPE } from "../../../lib/workflow-node-types";
import type { NodeExecutionResult, StepParams } from "../../types";
import { loadWorkspaceDataExecution } from "../workspace-data-execution";
import { interpolateTemplateWithDiagnostics } from "./utils";

export async function executeWorkspaceDataReadStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	try {
		const { config, binding } = await loadWorkspaceDataExecution(
			params,
			WORKSPACE_DATA_READ_NODE_TYPE,
		);
		const key = interpolateTemplateWithDiagnostics(
			config.key,
			params.inputs,
		);
		if (key.unresolved.length > 0) {
			throw new Error(
				"Workspace data key contains unresolved references",
			);
		}
		const record = await getWorkspaceWorkflowRecord({
			binding,
			collection: config.collection,
			key: key.text,
			scope: config.scope,
		});
		return {
			success: true,
			output: {
				value: record?.value ?? null,
				version: record?.version ?? 0,
				found: record !== null,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Workspace data read failed",
		};
	}
}
