/**
 * Direct repository instruction reads for MCP. The gateway repeats its own
 * credential-bound read gate around provider work, while the API service owns
 * the project permission and pinned repository fence.
 */
import {
	type DirectRepositoryState,
	getDirectRepositoryState,
} from "@repo/api/modules/v1/instruction-direct-repository";

export type GatewayDirectInstructionRead =
	| { kind: "denied" }
	| { kind: "legacy" }
	| {
			kind: "repository";
			state: Extract<DirectRepositoryState, { availability: "READY" }>;
	  }
	| {
			kind: "unavailable";
			state: Exclude<DirectRepositoryState, { availability: "READY" }>;
	  };

/**
 * Decide whether a gateway instruction call reads its direct repository or
 * continues through an uploaded/migrating snapshot. A gateway-specific read
 * check is repeated after state resolution so an organization-bound MCP
 * credential cannot release metadata after its project access changes.
 */
export async function resolveGatewayDirectInstructionRead(input: {
	projectId: string;
	userId: string;
	ensureInstructionRead: () => Promise<boolean>;
}): Promise<GatewayDirectInstructionRead> {
	if (!(await input.ensureInstructionRead())) {
		return { kind: "denied" };
	}
	const state = await getDirectRepositoryState({
		projectId: input.projectId,
		userId: input.userId,
	});
	if (!(await input.ensureInstructionRead())) {
		return { kind: "denied" };
	}
	if (state.availability === "READY") {
		return { kind: "repository", state };
	}
	if (state.availability === "UPLOAD" || state.availability === "MIGRATING") {
		return { kind: "legacy" };
	}
	return { kind: "unavailable", state };
}
