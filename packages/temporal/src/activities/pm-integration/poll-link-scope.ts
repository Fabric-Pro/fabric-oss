/**
 * Which linked stories the hourly PM poll may read from the project's active
 * PM tool (Fizzy #2304 staging follow-up).
 *
 * A story keeps its `externalId` when the project switches PM tools, and the
 * poll used to request every such id from the NEW tool by bare id — a Fizzy
 * card number sent to GitLab as an issue iid. Those reads either fail every
 * cycle (so the fetch never completes and the freshness watermark never
 * advances) or, when the number exists in the new tool too, read an unrelated
 * ticket and apply its terminal state to the wrong story.
 *
 * Scope is by tool TYPE, never by server id: a project that moved to another
 * server row of the same tool (GitLab MCP → gitlab-official, a re-created
 * Fizzy server) keeps polling its stories exactly as before. A stamp that no
 * longer resolves, and a missing stamp (import-created links carry none), fall
 * back to the URL host — the same signal `detectExternalLinkMismatch` uses.
 */
import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
} from "@repo/database";
import {
	mapKeyToPatternType,
	type PmPatternType,
} from "./pm-server-provenance-match";
import { belongsToDifferentKnownTool, safeHost } from "./pm-tool-mismatch";

export interface PollLinkProvenance {
	externalMcpServerId: string | null;
	externalUrl: string | null;
}

/**
 * Pure. `stampToolType` is the resolved tool type of the link's
 * `externalMcpServerId`, or null when there is no stamp or it did not resolve.
 */
export function isLinkFromActiveTool(
	link: PollLinkProvenance,
	activeToolType: PmPatternType | null,
	stampToolType: PmPatternType | null,
): boolean {
	if (activeToolType === null) {
		return true;
	}
	if (stampToolType !== null) {
		return stampToolType === activeToolType;
	}
	const host = link.externalUrl ? safeHost(link.externalUrl) : null;
	return host === null || !belongsToDifferentKnownTool(host, activeToolType);
}

export type StampToolTypeResolver = (
	serverId: string | null | undefined,
) => Promise<PmPatternType | null>;

/** Memoised per activity run: one lookup per distinct stamped server id. */
export function createStampToolTypeResolver(): StampToolTypeResolver {
	const cache = new Map<string, Promise<PmPatternType | null>>();
	return (serverId) => {
		if (!serverId) {
			return Promise.resolve(null);
		}
		let resolved = cache.get(serverId);
		if (!resolved) {
			resolved = resolveStampToolType(serverId);
			cache.set(serverId, resolved);
		}
		return resolved;
	};
}

async function resolveStampToolType(
	serverId: string,
): Promise<PmPatternType | null> {
	if (isPmServerIdKeySentinel(serverId)) {
		return mapKeyToPatternType(readPmServerIdKeySentinel(serverId));
	}
	const server = await db.mCPServer.findUnique({
		where: { id: serverId },
		select: { key: true },
	});
	return mapKeyToPatternType(server?.key ?? null);
}

/** Resolves the link's stamp, then applies `isLinkFromActiveTool`. */
export async function linkBelongsToActiveTool(
	link: Partial<PollLinkProvenance>,
	activeToolType: PmPatternType | null,
	resolveStamp: StampToolTypeResolver,
): Promise<boolean> {
	if (activeToolType === null) {
		return true;
	}
	const provenance: PollLinkProvenance = {
		externalMcpServerId: link.externalMcpServerId ?? null,
		externalUrl: link.externalUrl ?? null,
	};
	return isLinkFromActiveTool(
		provenance,
		activeToolType,
		await resolveStamp(provenance.externalMcpServerId),
	);
}
