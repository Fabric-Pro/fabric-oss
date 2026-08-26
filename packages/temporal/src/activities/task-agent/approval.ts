/**
 * Approval Validation
 *
 * Validates required fields for approval-gated tools.
 */

import type {
	ValidateApprovalFieldsInput,
	ValidateApprovalFieldsResult,
} from "./types";

/**
 * Validate that required fields are present in approval data
 * Returns null if valid, or an error message if validation fails
 */
export function validateApprovalFields(
	input: ValidateApprovalFieldsInput,
): ValidateApprovalFieldsResult {
	const { toolName, data, mcpConfig } = input;

	// Tool name format: "ServerName__methodName"
	const parts = toolName.split("__");
	if (parts.length !== 2) {
		return { valid: true }; // Can't validate, assume valid
	}

	const [serverName, methodName] = parts;

	// Find the matching tool in MCP config
	const matchingTool = mcpConfig.tools.find((t) => {
		const toolServerName = t.name.split("__")[0];
		const toolMethodName = t.name.split("__")[1];
		return toolServerName === serverName && toolMethodName === methodName;
	});

	if (!matchingTool?.approvalRequiredFields?.length) {
		return { valid: true }; // No required fields defined
	}

	// Check for missing required fields
	const missingFields = matchingTool.approvalRequiredFields.filter(
		(field) =>
			data[field] === undefined ||
			data[field] === null ||
			data[field] === "",
	);

	if (missingFields.length > 0) {
		const fieldList = matchingTool.approvalRequiredFields
			.map((f) => `"${f}"`)
			.join(", ");
		return {
			valid: false,
			error: `Missing required fields for ${toolName}: ${missingFields.join(", ")}. Please include these fields in the data parameter: ${fieldList}.`,
			missingFields,
		};
	}

	return { valid: true };
}
