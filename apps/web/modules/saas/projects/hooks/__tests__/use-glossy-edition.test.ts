/**
 * The Glossy edition hooks (Fizzy #2589, U14; R9, KTD15, KTD16).
 *
 * Pinned here: the poll cadence and its stop rule (`glossyPollInterval`), the
 * preview's hold on signed URLs across polls (`useHeldSignedUrls`), and the
 * browser-side visual renderer's queue and cache (`useGlossyVisualImages`):
 * one render at a time, a render per spec hash and palette, and a loop that
 * stops once the page is gone.
 *
 * The renderer (mermaid, canvas) is replaced by deferred promises, so each
 * test decides when a render finishes.
 */

import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renders = vi.hoisted(() => ({
	pending: [] as Array<{
		title: string | undefined;
		resolve: (value: unknown) => void;
		reject: (error: unknown) => void;
	}>,
	renderGlossyVisual: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { glossy: { get: vi.fn() } } },
}));

vi.mock("../../lib/glossy/visual-render", () => ({
	renderGlossyVisual: (spec: { title?: string }, palette: unknown) =>
		renders.renderGlossyVisual(spec, palette),
}));

import { deriveGlossyPalette } from "../../lib/glossy/palette";
import {
	type GlossyBuildState,
	type GlossySignedUrls,
	glossyPollInterval,
	SIGNED_URL_REFRESH_MS,
	useGlossyVisualImages,
	useHeldSignedUrls,
} from "../use-glossy-edition";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function building(startedAt: number): GlossyBuildState {
	return {
		status: "building",
		step: "rewriting",
		sectionsDone: 1,
		sectionsTotal: 4,
		startedAt: new Date(startedAt),
		startedBy: null,
	};
}

function failed(stuck: boolean): GlossyBuildState {
	return {
		status: "failed",
		errorCode: "BUILD_FAILED",
		errorMessage: null,
		stuck,
		startedAt: new Date(NOW - 600_000),
		finishedAt: null,
		startedBy: null,
	};
}

describe("glossyPollInterval", () => {
	it.each<[string, GlossyBuildState | undefined, number | false]>([
		["no answer yet", undefined, false],
		["idle", { status: "idle" }, false],
		["failed", failed(false), false],
		["stuck", failed(true), false],
		["building, just started", building(NOW), 3_000],
		["building for 119 s", building(NOW - 119_000), 3_000],
		["building for 121 s", building(NOW - 121_000), 10_000],
	])("%s → %s", (_label, build, expected) => {
		expect(glossyPollInterval(build, NOW)).toBe(expected);
	});
});

describe("useHeldSignedUrls", () => {
	const signed = (path: string, signature: string) =>
		`https://storage.example.com/${path}?X-Amz-Signature=${signature}`;

	function urls(
		signature: string,
		{
			imageKeys = ["document-media/project-1/document-1/a.png"],
			preparerLogo = "logos/example-org.png" as string | null,
			recipientLogo = null as string | null,
		} = {},
	): GlossySignedUrls {
		return {
			imageUrls: Object.fromEntries(
				imageKeys.map((key) => [key, signed(key, signature)]),
			),
			preparerLogoUrl: preparerLogo
				? signed(preparerLogo, signature)
				: null,
			recipientLogoUrl: recipientLogo
				? signed(recipientLogo, signature)
				: null,
		};
	}

	function hold(initial: GlossySignedUrls, at = NOW) {
		return renderHook(
			({ value, updatedAt }) => useHeldSignedUrls(value, updatedAt),
			{ initialProps: { value: initial, updatedAt: at } },
		);
	}

	it("keeps what it first showed while the same objects are only re-signed", () => {
		const first = urls("sig-1");
		const { result, rerender } = hold(first);
		expect(result.current).toEqual(first);

		rerender({ value: urls("sig-2"), updatedAt: NOW + 3_000 });
		expect(result.current).toEqual(first);
		rerender({ value: urls("sig-3"), updatedAt: NOW + 6_000 });
		expect(result.current).toEqual(first);
	});

	it("takes the fresh set when an image is added or removed", () => {
		const { result, rerender } = hold(urls("sig-1"));

		const added = urls("sig-2", {
			imageKeys: [
				"document-media/project-1/document-1/a.png",
				"document-media/project-1/document-1/b.png",
			],
		});
		rerender({ value: added, updatedAt: NOW + 3_000 });
		expect(result.current).toEqual(added);

		const removed = urls("sig-3", { imageKeys: [] });
		rerender({ value: removed, updatedAt: NOW + 6_000 });
		expect(result.current).toEqual(removed);
	});

	it("takes the fresh set when a logo appears, goes, or is replaced", () => {
		const { result, rerender } = hold(urls("sig-1"));

		const recipient = urls("sig-2", {
			recipientLogo: "recipient-logos/example-corp.png",
		});
		rerender({ value: recipient, updatedAt: NOW + 3_000 });
		expect(result.current).toEqual(recipient);

		const replaced = urls("sig-3", {
			preparerLogo: "logos/example-org-v2.png",
			recipientLogo: "recipient-logos/example-corp.png",
		});
		rerender({ value: replaced, updatedAt: NOW + 6_000 });
		expect(result.current).toEqual(replaced);

		const gone = urls("sig-4", {
			preparerLogo: null,
			recipientLogo: "recipient-logos/example-corp.png",
		});
		rerender({ value: gone, updatedAt: NOW + 9_000 });
		expect(result.current).toEqual(gone);
	});

	it("takes the fresh set once what it holds is older than the refresh age", () => {
		const first = urls("sig-1");
		const { result, rerender } = hold(first);

		rerender({
			value: urls("sig-2"),
			updatedAt: NOW + SIGNED_URL_REFRESH_MS,
		});
		expect(result.current).toEqual(first);

		const fresh = urls("sig-3");
		rerender({ value: fresh, updatedAt: NOW + SIGNED_URL_REFRESH_MS + 1 });
		expect(result.current).toEqual(fresh);
		// And holds the new set from then on.
		rerender({
			value: urls("sig-4"),
			updatedAt: NOW + SIGNED_URL_REFRESH_MS + 3_000,
		});
		expect(result.current).toEqual(fresh);
	});
});

describe("useGlossyVisualImages", () => {
	const IMAGE = {
		dataUrl: "data:image/png;base64,AAAA",
		width: 1,
		height: 1,
	};

	function visual(title: string, specHash: string): EditionVisual {
		return {
			kind: "timeline",
			spec: {
				kind: "timeline",
				title,
				items: [{ date: "Q3 2026", label: "Discovery" }],
			},
			specHash,
			source: "detected",
		};
	}

	const brandPalette = deriveGlossyPalette({});
	const overridePalette = deriveGlossyPalette({
		overrides: { primary: "#1a73e8", accents: [] },
	});

	/** Finish the oldest render still in flight. */
	async function finishNext(outcome: "ok" | "fail" = "ok") {
		const next = renders.pending.shift();
		if (!next) {
			throw new Error("No render in flight");
		}
		await act(async () => {
			if (outcome === "ok") {
				next.resolve(IMAGE);
			} else {
				next.reject(new Error("render failed"));
			}
		});
	}

	beforeEach(() => {
		renders.pending.length = 0;
		renders.renderGlossyVisual.mockReset();
		renders.renderGlossyVisual.mockImplementation(
			(spec: { title?: string }) =>
				new Promise((resolve, reject) => {
					renders.pending.push({
						title: spec.title,
						resolve,
						reject,
					});
				}),
		);
	});

	it("renders one visual at a time, in order", async () => {
		const visuals = {
			a: visual("Alpha", "hash-a"),
			b: visual("Bravo", "hash-b"),
		};
		const { result } = renderHook(() =>
			useGlossyVisualImages(visuals, brandPalette),
		);

		expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(1);
		expect(renders.pending.map((entry) => entry.title)).toEqual(["Alpha"]);
		expect(result.current.images.size).toBe(0);

		await finishNext();
		await waitFor(() =>
			expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(2),
		);
		expect(renders.pending.map((entry) => entry.title)).toEqual(["Bravo"]);
		expect([...result.current.images.keys()]).toEqual(["a"]);

		await finishNext();
		await waitFor(() => expect(result.current.images.size).toBe(2));
		expect(result.current.failed.size).toBe(0);
	});

	it("reuses renders by spec hash and palette, and renders only what changed", async () => {
		const { result, rerender } = renderHook(
			({ visuals }) => useGlossyVisualImages(visuals, brandPalette),
			{
				initialProps: {
					visuals: {
						a: visual("Alpha", "hash-a"),
						b: visual("Bravo", "hash-b"),
					} as Record<string, EditionVisual>,
				},
			},
		);
		await finishNext();
		await waitFor(() => expect(renders.pending).toHaveLength(1));
		await finishNext();
		await waitFor(() => expect(result.current.images.size).toBe(2));

		// A refetch hands the same visuals over as new objects.
		rerender({
			visuals: {
				a: visual("Alpha", "hash-a"),
				b: visual("Bravo", "hash-b"),
			},
		});
		expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(2);
		expect(result.current.images.size).toBe(2);

		// A regenerate replaces one spec.
		rerender({
			visuals: {
				a: visual("Alpha", "hash-a"),
				b: visual("Bravo again", "hash-b2"),
			},
		});
		expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(3);
		expect(renders.pending.map((entry) => entry.title)).toEqual([
			"Bravo again",
		]);
		expect([...result.current.images.keys()]).toEqual(["a"]);
		await finishNext();
		await waitFor(() => expect(result.current.images.size).toBe(2));

		expect(
			result.current.lookup({ b: visual("Bravo", "hash-b") }).size,
		).toBe(1);
	});

	it("renders every visual again for a new palette", async () => {
		const visuals = { a: visual("Alpha", "hash-a") };
		const { result, rerender } = renderHook(
			({ palette }) => useGlossyVisualImages(visuals, palette),
			{ initialProps: { palette: brandPalette } },
		);
		await finishNext();
		await waitFor(() => expect(result.current.images.size).toBe(1));

		rerender({ palette: overridePalette });
		expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(2);
		expect(renders.renderGlossyVisual.mock.calls[1][1]).toEqual(
			overridePalette,
		);
		// Nothing is shown in the old colors meanwhile.
		expect(result.current.images.size).toBe(0);
		await finishNext();
		await waitFor(() => expect(result.current.images.size).toBe(1));
	});

	it("reports a visual that could not render as failed", async () => {
		const visuals = { a: visual("Alpha", "hash-a") };
		const { result } = renderHook(() =>
			useGlossyVisualImages(visuals, brandPalette),
		);

		await finishNext("fail");
		await waitFor(() => expect([...result.current.failed]).toEqual(["a"]));
		expect(result.current.images.size).toBe(0);
	});

	it("stops rendering once the page is gone", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const visuals = {
				a: visual("Alpha", "hash-a"),
				b: visual("Bravo", "hash-b"),
			};
			const { unmount } = renderHook(() =>
				useGlossyVisualImages(visuals, brandPalette),
			);
			expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(1);

			unmount();
			await finishNext();
			await act(async () => {
				await Promise.resolve();
			});

			expect(renders.renderGlossyVisual).toHaveBeenCalledTimes(1);
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});
});
