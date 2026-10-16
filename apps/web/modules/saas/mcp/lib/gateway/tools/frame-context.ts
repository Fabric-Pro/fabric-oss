/**
 * What the frame, page and version tools share: which page a call means, the
 * page itself once the caller may open it, and where a person opens it.
 */

import { db, type FrameSurface, getAccessibleFrameById } from "@repo/database";
import type { GatewaySession } from "../types";

export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** An object argument as a record, or an empty one for anything else. */
export function plainObjectOf(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

/**
 * A `limit` argument as a whole number from 1 to `max`, or `fallback` for
 * anything that is not a finite number.
 */
export function clampLimit(
	value: unknown,
	{ fallback, max }: { fallback: number; max: number },
): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(1, Math.floor(value)))
		: fallback;
}

export const NO_PAGE_OPEN =
	"No page to act on. Pass `frameId`, or open the Workspace first.";

/**
 * The page a call means: the `frameId` it names, else the Workspace the person
 * has open (the agent's default; a page's own calls always name their page).
 * Never `id`: the file tools take the id of a file there, and reading it as a
 * page would open the file's id as a page.
 */
export function frameIdOf(
	args: Record<string, unknown>,
	session: Pick<GatewaySession, "actingContext">,
): string | undefined {
	return (
		nonEmptyString(args.frameId) ??
		nonEmptyString(session.actingContext?.workspaceId)
	);
}

/** The frame tools that predate the page tools take the frame as `id` as well. */
export function legacyFrameIdOf(
	args: Record<string, unknown>,
	session: Pick<GatewaySession, "actingContext">,
): string | undefined {
	return (
		nonEmptyString(args.frameId) ??
		nonEmptyString(args.id) ??
		frameIdOf(args, session)
	);
}

/** The page, when the caller may open it, in the caller's organization. */
export async function accessibleFrame(
	frameId: string,
	session: Pick<GatewaySession, "userId" | "email" | "organizationId">,
) {
	if (!session.organizationId) {
		return null;
	}
	return getAccessibleFrameById({
		id: frameId,
		userId: session.userId,
		userEmail: session.email,
		organizationId: session.organizationId,
	});
}

export async function organizationSlug(
	organizationId: string | null,
): Promise<string | undefined> {
	if (!organizationId) {
		return undefined;
	}
	const organization = await db.organization.findUnique({
		where: { id: organizationId },
		select: { slug: true },
	});
	return organization?.slug ?? undefined;
}

/** Where a person opens a frame that lives on a surface. */
export function pageUrl(
	slug: string | undefined,
	frame: { frameId: string; surface?: FrameSurface; projectId?: string },
): string | undefined {
	if (!slug) {
		return undefined;
	}
	if (frame.surface === "workspace") {
		return `/app/${slug}/workspaces/${frame.frameId}`;
	}
	if (frame.surface === "artifact" && frame.projectId) {
		return `/app/${slug}/projects/${frame.projectId}?tab=artifacts`;
	}
	return undefined;
}

export async function withPageUrl<
	T extends { frameId: string; surface?: FrameSurface; projectId?: string },
>(
	frame: T,
	session: Pick<GatewaySession, "organizationId">,
): Promise<T & { pageUrl?: string }> {
	if (!frame.surface) {
		return frame;
	}
	const url = pageUrl(await organizationSlug(session.organizationId), frame);
	return url ? { ...frame, pageUrl: url } : frame;
}
