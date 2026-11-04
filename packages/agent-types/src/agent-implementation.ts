/**
 * Admission guard shared by API and activity boundaries. Metadata is never code.
 * No Harness target is qualified by merely importing an implementation descriptor.
 */
export function getAgentImplementationAvailability(
	customInstructions: unknown,
): {
	available: boolean;
	reason?: string;
} {
	const custom =
		customInstructions !== null &&
		typeof customInstructions === "object" &&
		!Array.isArray(customInstructions)
			? (customInstructions as Record<string, unknown>)
			: {};
	const descriptor = custom.portableImplementation;
	if (descriptor === undefined) {
		// Legacy agents have no implementation metadata and retain native execution.
		if (
			custom.portableDefinitionVersion !== undefined &&
			custom.portableDefinitionVersion !== "fabric.ai/v1"
		) {
			return invalid();
		}
		return { available: true };
	}
	if (
		!descriptor ||
		typeof descriptor !== "object" ||
		Array.isArray(descriptor)
	) {
		return invalid();
	}
	const value = descriptor as Record<string, unknown>;
	if (value.kind === "native") {
		// Reject malformed/unknown native-looking descriptors instead of silently
		// switching an imported implementation to the native worker.
		return Object.keys(value).length === 1 &&
			(custom.portableDefinitionVersion === undefined ||
				custom.portableDefinitionVersion === "fabric.ai/v1" ||
				custom.portableDefinitionVersion === "fabric.ai/v2")
			? { available: true }
			: invalid();
	}
	if (
		value.kind === "harness_finite" ||
		value.kind === "harness_persistent"
	) {
		return {
			available: false,
			reason: "This Harness implementation is retained as a draft. Artifact verification and a qualified execution adapter are required before publication or execution.",
		};
	}
	return invalid();
}
function invalid() {
	return {
		available: false,
		reason: "The agent implementation descriptor is invalid or unsupported. Import a valid reviewed release.",
	};
}
