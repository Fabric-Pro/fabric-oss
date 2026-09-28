"use client";

import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import type { VisualSpec } from "@repo/utils/glossy/visual-spec";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOrpcCode } from "../components/field-mapping/orpc-error";
import type { GlossyPalette } from "../lib/glossy/palette";
import {
	type RenderedGlossyVisual,
	renderGlossyVisual,
} from "../lib/glossy/visual-render";

/** What `projects.glossy.get` returns (Fizzy #2589). */
export type GlossyEdition = Awaited<
	ReturnType<typeof orpcClient.projects.glossy.get>
>;
export type GlossyBuildState = GlossyEdition["build"];
export type GlossyVisualDecision = "ACCEPTED" | "DISCARDED";

/** Cadence while a build runs and is likely to finish soon. */
const POLL_FAST_MS = 3_000;
/** Cadence once a build has run long enough that seconds no longer matter. */
const POLL_SLOW_MS = 10_000;
/** How long a build is polled at the fast cadence (the build targets two minutes). */
const FAST_POLL_WINDOW_MS = 2 * 60 * 1000;

/** A refusal, not a fault: retrying cannot change the answer. */
const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

/**
 * Signed image and logo reads last an hour. A download from an older page
 * asks for fresh ones first, and the preview trades the URLs it holds for
 * fresh ones past this age.
 */
export const SIGNED_URL_REFRESH_MS = 45 * 60 * 1000;

/** The server refused the edition (gone, gate off, access revoked): nothing to retry or poll. */
export function isGlossyAccessDenied(error: unknown): boolean {
	return DENIED_CODES.has(getOrpcCode(error) ?? "");
}

export function glossyEditionQueryKey(projectId: string, documentId: string) {
	return ["projects", "glossy", "edition", projectId, documentId] as const;
}

/**
 * How long to wait before asking about the edition again, or `false` to stop.
 * Only a running build changes anything on its own; every other change comes
 * from an action on this page, which refetches itself. The build reports its
 * progress on its attempt row, so the page is a viewer of that row: fast while
 * the build is young, slower once it has proved to be a long one.
 */
export function glossyPollInterval(
	build: GlossyBuildState | undefined,
	now: number = Date.now(),
): number | false {
	if (build?.status !== "building") {
		return false;
	}
	const elapsed = now - new Date(build.startedAt).getTime();
	return elapsed < FAST_POLL_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

/**
 * The document's Glossy edition, polled while a build runs (R9). Reading it
 * never starts anything: a build starts only from an explicit action.
 *
 * A refusal ends the polling: the last good answer may still say `building`,
 * but a server that stopped answering for this caller will not start again
 * by being asked every few seconds.
 */
export function useGlossyEdition(projectId: string, documentId: string) {
	return useQuery({
		queryKey: glossyEditionQueryKey(projectId, documentId),
		queryFn: () =>
			orpcClient.projects.glossy.get({ projectId, documentId }),
		refetchInterval: (query) =>
			query.state.status === "error" &&
			isGlossyAccessDenied(query.state.error)
				? false
				: glossyPollInterval(query.state.data?.build),
		retry: (failureCount, error) =>
			!isGlossyAccessDenied(error) && failureCount < 2,
	});
}

/** The signed reads a preview shows: the document's own uploads and both logos. */
export interface GlossySignedUrls {
	imageUrls: Readonly<Record<string, string>>;
	preparerLogoUrl: string | null;
	recipientLogoUrl: string | null;
}

/** A signed URL without its signature: the object it reads. */
function signedObject(url: string | null): string | null {
	if (!url) {
		return null;
	}
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url;
	}
}

/** What the URLs point at, whatever they were signed with. */
function signedUrlsIdentity(urls: GlossySignedUrls): string {
	return JSON.stringify([
		Object.keys(urls.imageUrls).sort(),
		signedObject(urls.preparerLogoUrl),
		signedObject(urls.recipientLogoUrl),
	]);
}

/**
 * The signed URLs the preview shows, held across polls (display only).
 *
 * `projects.glossy.get` signs every image and logo afresh on each call, so
 * during a build every poll would hand each `<img>` a new `src` and the
 * browser would fetch them all again. The held set is traded for the fresh
 * one only when an image or logo is added, removed, or replaced, or once the
 * held set is older than `SIGNED_URL_REFRESH_MS`, before it expires. A
 * download does not read these: it takes the query's own data, refreshed
 * when old.
 */
export function useHeldSignedUrls(
	urls: GlossySignedUrls,
	dataUpdatedAt: number,
): GlossySignedUrls {
	const identity = signedUrlsIdentity(urls);
	const [held, setHeld] = useState({ urls, identity, heldAt: dataUpdatedAt });
	const stale =
		identity !== held.identity ||
		dataUpdatedAt - held.heldAt > SIGNED_URL_REFRESH_MS;
	if (stale) {
		// Derived state, adjusted while rendering: React re-renders at once
		// with the new hold, before anything is committed.
		setHeld({ urls, identity, heldAt: dataUpdatedAt });
		return urls;
	}
	return held.urls;
}

export interface GlossyVisualImages {
	/** Rendered images of the visuals given, by visual key. */
	images: ReadonlyMap<string, RenderedGlossyVisual>;
	/** Visuals that could not be rendered (KTD15: shown as "could not render"). */
	failed: ReadonlySet<string>;
	/**
	 * Images already rendered for any set of visuals — a fresher read than the
	 * one this hook was given — so a download reuses them. A visual whose spec
	 * changed since is not in the map; the download renders it itself.
	 */
	lookup: (
		visuals: Readonly<Record<string, EditionVisual>>,
	) => Map<string, RenderedGlossyVisual>;
}

interface QueuedVisual {
	cacheKey: string;
	spec: VisualSpec;
	palette: GlossyPalette;
}

function paletteCacheKey(palette: GlossyPalette): string {
	return JSON.stringify(palette);
}

/**
 * Render an edition's visuals in the browser with the live palette (KTD15),
 * one at a time — mermaid.js is a singleton — and remember each by its spec
 * hash and palette, so a regenerate, a review, or a refetch re-renders only
 * what actually changed.
 */
export function useGlossyVisualImages(
	visuals: Readonly<Record<string, EditionVisual>> | null,
	palette: GlossyPalette,
): GlossyVisualImages {
	const paletteKey = paletteCacheKey(palette);
	const cache = useRef(new Map<string, RenderedGlossyVisual | null>());
	const queue = useRef<QueuedVisual[]>([]);
	const queued = useRef(new Set<string>());
	const running = useRef(false);
	const mounted = useRef(true);
	const [, setRendered] = useState(0);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (!visuals) {
			return;
		}
		for (const visual of Object.values(visuals)) {
			const cacheKey = `${visual.specHash}|${paletteKey}`;
			if (cache.current.has(cacheKey) || queued.current.has(cacheKey)) {
				continue;
			}
			queued.current.add(cacheKey);
			queue.current.push({ cacheKey, spec: visual.spec, palette });
		}
		if (running.current) {
			return;
		}
		running.current = true;
		void (async () => {
			while (queue.current.length > 0 && mounted.current) {
				const next = queue.current.shift() as QueuedVisual;
				let image: RenderedGlossyVisual | null = null;
				try {
					// An unresolved best-fit slot has no renderer.
					image =
						next.spec.kind === "auto"
							? null
							: await renderGlossyVisual(next.spec, next.palette);
				} catch {
					image = null;
				}
				cache.current.set(next.cacheKey, image);
				queued.current.delete(next.cacheKey);
				if (mounted.current) {
					setRendered((count) => count + 1);
				}
			}
			running.current = false;
		})();
	}, [visuals, palette, paletteKey]);

	const lookup = useCallback(
		(given: Readonly<Record<string, EditionVisual>>) => {
			const found = new Map<string, RenderedGlossyVisual>();
			for (const [visualKey, visual] of Object.entries(given)) {
				const image = cache.current.get(
					`${visual.specHash}|${paletteKey}`,
				);
				if (image) {
					found.set(visualKey, image);
				}
			}
			return found;
		},
		[paletteKey],
	);

	const images = new Map<string, RenderedGlossyVisual>();
	const failed = new Set<string>();
	for (const [visualKey, visual] of Object.entries(visuals ?? {})) {
		const cacheKey = `${visual.specHash}|${paletteKey}`;
		if (!cache.current.has(cacheKey)) {
			continue;
		}
		const image = cache.current.get(cacheKey);
		if (image) {
			images.set(visualKey, image);
		} else {
			failed.add(visualKey);
		}
	}
	return { images, failed, lookup };
}
