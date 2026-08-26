// Portions of this file are derived from Corsair (https://github.com/corsairdotdev/corsair)
// Original work © Corsair contributors. Licensed under Apache-2.0.
// Modifications © TechFabric LLC. Licensed under MIT (see the containing package's LICENSE).
// See THIRD_PARTY_NOTICES.md at the repository root for full attribution.

import type {
	EndpointRiskLevel,
	PermissionMode,
	PermissionPolicy,
} from "./types.js";

/**
 * Permission matrix: (mode × riskLevel) → policy.
 * Lifted verbatim from Corsair's `core/permissions/index.ts`.
 */
export const PERMISSION_MATRIX: Record<
	PermissionMode,
	Record<EndpointRiskLevel, PermissionPolicy>
> = {
	open: { read: "allow", write: "allow", destructive: "allow" },
	cautious: {
		read: "allow",
		write: "allow",
		destructive: "require_approval",
	},
	strict: { read: "allow", write: "require_approval", destructive: "deny" },
	readonly: { read: "allow", write: "deny", destructive: "deny" },
};

/**
 * Resolve the effective policy for an endpoint.
 * Per-endpoint overrides take precedence over the mode default.
 */
export function evaluatePermission(
	riskLevel: EndpointRiskLevel,
	mode: PermissionMode,
	override?: PermissionPolicy,
): PermissionPolicy {
	if (override !== undefined) {
		return override;
	}
	return PERMISSION_MATRIX[mode][riskLevel];
}

/** Parse a duration string (`30s`, `10m`, `1h`, `2h30m`, `1d`) into milliseconds. */
export function parseDurationMs(duration: string): number {
	const regex = /(\d+)(d|h|m|s)/g;
	let total = 0;
	let match: RegExpExecArray | null = regex.exec(duration);
	while (match !== null) {
		const value = Number.parseInt(match[1] ?? "0", 10);
		switch (match[2]) {
			case "d":
				total += value * 86_400_000;
				break;
			case "h":
				total += value * 3_600_000;
				break;
			case "m":
				total += value * 60_000;
				break;
			case "s":
				total += value * 1_000;
				break;
		}
		match = regex.exec(duration);
	}
	// Default to 10 minutes if the input was unparseable or zero.
	return total > 0 ? total : 10 * 60 * 1_000;
}
