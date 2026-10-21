import { Buffer } from "node:buffer";
import { canRunOrganizationWorkflows, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	NativePlatformReadConfigSchema,
	NATIVE_PLATFORM_READ_MAX_BYTES,
	readPublishedNativePlatformReadConfig,
} from "../../../lib/native-platform-read-config";
import { executeNativePlatformRead } from "../../shared/native-platform-read-registry";
import type { NodeExecutionResult, StepParams } from "../../types";
import { loadPublishedExecutionConfig } from "../workflow-execution-definition";
import { interpolateTemplateWithDiagnostics } from "./utils";

export async function executeNativePlatformReadStep(
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
	if (
		!organizationId ||
		!workflowId ||
		!executionId ||
		!nodeId ||
		!projectId
	) {
		return {
			success: false,
			error: "Native reads require an organization and project workflow execution",
		};
	}
	try {
		if (
			!(await canRunOrganizationWorkflows(userId, organizationId)) ||
			!(await hasProjectAccess(projectId, userId))
		) {
			return {
				success: false,
				error: "No permission to run this workflow",
			};
		}
		const { config } = await loadPublishedExecutionConfig({
			scope: {
				userId,
				organizationId,
				workflowId,
				executionId,
				projectId,
			},
			nodeId,
			nodeConfig: params.nodeConfig,
			readConfig: readPublishedNativePlatformReadConfig,
			parseConfig: (value) => NativePlatformReadConfigSchema.parse(value),
		});
		const args = interpolateTemplateWithDiagnostics(
			config.arguments,
			params.inputs,
		);
		if (args.unresolved.length > 0) {
			return {
				success: false,
				error: "Native read arguments contain unresolved references",
			};
		}
		if (Buffer.byteLength(args.text, "utf8") > 16384) {
			return {
				success: false,
				error: "Native read arguments exceed 16 KiB",
			};
		}
		const parsed = z
			.record(z.string(), z.json())
			.safeParse(JSON.parse(args.text));
		if (!parsed.success) {
			return {
				success: false,
				error: "Native read arguments must be a JSON object",
			};
		}
		if (
			parsed.data.projectId !== undefined &&
			parsed.data.projectId !== projectId
		) {
			return {
				success: false,
				error: "Native read project differs from the workflow project",
			};
		}
		const result = await executeNativePlatformRead(
			config.toolName,
			{ ...parsed.data, projectId },
			{ userId, organizationId },
		);
		if (!result.success) {
			return { success: false, error: result.error };
		}
		if (
			Buffer.byteLength(
				JSON.stringify({ result: result.result }),
				"utf8",
			) > NATIVE_PLATFORM_READ_MAX_BYTES
		) {
			return {
				success: false,
				error: "Native read result exceeds 128 KiB; request a smaller page or batch",
			};
		}
		return { success: true, output: { result: result.result } };
	} catch {
		return {
			success: false,
			error: "Native platform read could not complete. Check execution access and the published configuration.",
		};
	}
}
