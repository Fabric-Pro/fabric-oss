import { getAccessibleFrameById } from "@repo/database";

/** Validate the launch page independently of placement and retrieval defaults. */
export async function resolveUsageFrame(input: {
	launchFrameId: unknown;
	legacyLaunchFrameId?: unknown;
	userId: string;
	userEmail?: string;
	organizationId: string;
	projectId?: string;
}): Promise<
	| { usageFrameId?: string; error?: never }
	| { error: Response; usageFrameId?: never }
> {
	if (
		input.launchFrameId != null &&
		input.legacyLaunchFrameId != null &&
		input.launchFrameId !== input.legacyLaunchFrameId
	) {
		return {
			error: Response.json(
				{ error: "Conflicting launch frames" },
				{ status: 400 },
			),
		};
	}
	const launchFrameId = input.launchFrameId ?? input.legacyLaunchFrameId;
	if (launchFrameId === undefined || launchFrameId === null) {
		return {};
	}
	if (
		typeof launchFrameId !== "string" ||
		launchFrameId.length === 0 ||
		launchFrameId.length > 200
	) {
		return {
			error: Response.json(
				{ error: "Invalid launch frame" },
				{ status: 400 },
			),
		};
	}
	const frame = await getAccessibleFrameById({
		id: launchFrameId,
		userId: input.userId,
		userEmail: input.userEmail,
		organizationId: input.organizationId,
	});
	if (!frame || (frame.projectId && frame.projectId !== input.projectId)) {
		return {
			error: Response.json(
				{ error: "Launch frame is not accessible in this project" },
				{ status: 403 },
			),
		};
	}
	return { usageFrameId: frame.id };
}
