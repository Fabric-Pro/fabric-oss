import { setWorkspaceWorkflowRecord } from "@repo/database";
import { z } from "zod";
import { WorkspaceDataWriteConfigSchema } from "../../../lib/workspace-data-config";
import { WORKSPACE_DATA_WRITE_NODE_TYPE } from "../../../lib/workflow-node-types";
import type { NodeExecutionResult, StepParams } from "../../types";
import { loadWorkspaceDataExecution } from "../workspace-data-execution";
import { interpolateTemplateWithDiagnostics } from "./utils";

export async function executeWorkspaceDataWriteStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	try {
		const authorized = await loadWorkspaceDataExecution(
			params,
			WORKSPACE_DATA_WRITE_NODE_TYPE,
		);
		const config = WorkspaceDataWriteConfigSchema.parse(authorized.config);
		const key = interpolateTemplateWithDiagnostics(
			config.key,
			params.inputs,
		);
		const value = interpolateTemplateWithDiagnostics(
			config.value,
			params.inputs,
		);
		const version = interpolateTemplateWithDiagnostics(
			String(config.expectedVersion),
			params.inputs,
		);
		if (
			key.unresolved.length ||
			value.unresolved.length ||
			version.unresolved.length
		) {
			throw new Error(
				"Workspace data write contains unresolved references",
			);
		}
		const expectedVersion = z
			.number()
			.int()
			.nonnegative()
			.parse(JSON.parse(version.text));
		const parsedValue = z.json().parse(JSON.parse(value.text));
		const result = await setWorkspaceWorkflowRecord({
			binding: authorized.binding,
			collection: config.collection,
			key: key.text,
			scope: config.scope,
			value: parsedValue,
			expectedVersion,
		});
		const record = result.records[0];
		if (!record) {
			throw new Error("Workspace data write returned no record");
		}
		return {
			success: true,
			output: { version: record.version },
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Workspace data write failed",
		};
	}
}
