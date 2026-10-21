import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "../../lib/fabric-project-pm-tool-definitions";
import { NATIVE_PLATFORM_READ_TOOL_NAMES } from "../../lib/native-platform-read-config";
import { projectPmToolInput } from "../../lib/project-pm-input";
import { readProjectPmTool } from "./project-pm-service";

const registeredNames: ReadonlySet<string> = new Set(
	NATIVE_PLATFORM_READ_TOOL_NAMES,
);

export const NATIVE_PLATFORM_READ_DEFINITIONS =
	FABRIC_PROJECT_PM_TOOL_DEFINITIONS.filter(
		(tool) =>
			registeredNames.has(tool.name) &&
			tool.annotations.readOnlyHint === true,
	);

export async function executeNativePlatformRead(
	name: string,
	input: Record<string, unknown>,
	actor: { userId: string; organizationId: string },
) {
	if (
		!NATIVE_PLATFORM_READ_DEFINITIONS.some(
			(definition) => definition.name === name,
		)
	) {
		return {
			success: false,
			error: "Tool is not a registered native platform read",
		} as const;
	}
	const parsed = projectPmToolInput.safeParse({ name, input });
	if (!parsed.success) {
		return {
			success: false,
			error: "Invalid native read arguments. Use the tool's declared input schema.",
		} as const;
	}
	return readProjectPmTool(parsed.data, actor);
}
