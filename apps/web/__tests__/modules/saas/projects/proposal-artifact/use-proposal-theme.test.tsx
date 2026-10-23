/**
 * `useProposalTheme` and `ProposalThemeStyle` (Fizzy #2946): the shared theme
 * a client-document Proposal wears on its live Main page.
 *
 * Pinned here: the server decides — no request at all without the page's
 * hint, the neutral paint while the answer is pending, the document's own
 * paint once it arrives, and no theme after a refusal, which is never asked
 * again; a refetch that fails for another reason keeps the last paint; the
 * root carries the theme's class, target and every `--pa-*` property and no
 * colour utility; the static stylesheet lands in the head once however many
 * roots render it.
 *
 * Uploaded fonts: a file id in the tokens is read once through
 * `getThemeFont` and registered on `document.fonts` under the theme's own
 * alias, never the admin's family; the root names that alias ahead of the
 * family only once the face has loaded, and keeps its properties unchanged
 * before then, after a refusal, or without the Font Loading API (jsdom has
 * none, so it is stubbed where a test needs it); a new id swaps the face,
 * and leaving the page removes it. A face that finishes loading after the
 * page went, or after its id was replaced, is never registered or named.
 *
 * `@tanstack/react-query` is real and its retry policy is left at the client
 * default, so the hook's own `retry` is what decides; only the delay between
 * attempts is shortened.
 */

import {
	buildProposalThemeTokens,
	NEUTRAL_THEME,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	getThemeTokens: vi.fn(),
	getThemeFont: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getThemeTokens: (input: unknown) => api.getThemeTokens(input),
				getThemeFont: (input: unknown) => api.getThemeFont(input),
			},
		},
	},
}));

import {
	invalidateProposalTheme,
	ProposalThemeStyle,
	useProposalTheme,
} from "@saas/projects/components/proposal-artifact/use-proposal-theme";
import {
	DOCUMENT_ID,
	orpcError,
	PROJECT_ID,
} from "./proposal-artifact-fixtures";

/** A synthetic Style primary that reads as text on white paper. */
const STYLE_PRIMARY = "#1d4ed8";

/** Tokens as the server sends them; no logos, so no signed reads. */
function tokensWithPrimary(primaryColor: string | null) {
	return buildProposalThemeTokens({
		organization: null,
		style: primaryColor ? { primaryColor, accentColors: [] } : null,
		brandKit: null,
		recipient: null,
	});
}

/** Synthetic Brand kit families and an uploaded file id. */
const DISPLAY_FAMILY = "Example Display";
const BODY_FAMILY = "Example Text";
const FONT_FILE_ID = "00000000-0000-4000-8000-00000000f001";
const NEXT_FONT_FILE_ID = "00000000-0000-4000-8000-00000000f002";

/** The leading bytes of a WOFF2 file, `wOF2` and a flavour. */
const WOFF2_BYTES = [0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00];
const WOFF2_BASE64 = "d09GMgABAAA=";

/** Tokens whose Brand kit names both families and uploads the display one. */
function tokensWithFonts(displayFileId: string | null) {
	return buildProposalThemeTokens({
		organization: null,
		style: null,
		brandKit: {
			accentColors: [],
			displayFontFamily: DISPLAY_FAMILY,
			bodyFontFamily: BODY_FAMILY,
			displayFontFileId: displayFileId,
		},
		recipient: null,
	});
}

/**
 * A stand-in for the CSS Font Loading API: each `FontFace` built is kept,
 * and `load()` settles as the test asks: at once, refused, or only when the
 * test calls the face's `finishLoad`.
 */
function installFontLoading({
	loads = true,
}: {
	loads?: boolean | "deferred";
} = {}) {
	const faces: Array<{
		family: string;
		source: ArrayBuffer;
		finishLoad: () => void;
	}> = [];
	const fonts = { add: vi.fn(), delete: vi.fn() };
	class FakeFontFace {
		finishLoad: () => void = () => {};

		constructor(
			readonly family: string,
			readonly source: ArrayBuffer,
		) {
			faces.push(this);
		}

		load() {
			if (loads === "deferred") {
				return new Promise<this>((resolve) => {
					this.finishLoad = () => resolve(this);
				});
			}
			return loads
				? Promise.resolve(this)
				: Promise.reject(new Error("Not a font"));
		}
	}
	vi.stubGlobal("FontFace", FakeFontFace);
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: fonts,
	});
	return { faces, fonts };
}

let client: QueryClient;

function renderTheme(enabled = true) {
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, children);
	return renderHook(
		({ on }: { on: boolean }) =>
			useProposalTheme({
				projectId: PROJECT_ID,
				documentId: DOCUMENT_ID,
				enabled: on,
			}),
		{ wrapper, initialProps: { on: enabled } },
	);
}

function fontQueryState(fileId: string) {
	return client.getQueryCache().find({
		queryKey: [
			"projects",
			"proposalArtifact",
			"themeFont",
			PROJECT_ID,
			DOCUMENT_ID,
			"display",
			fileId,
		],
	})?.state.status;
}

function property(
	result: { current: ReturnType<typeof useProposalTheme> },
	name: `--pa-${string}`,
): unknown {
	return (result.current.rootProps?.style as Record<string, unknown>)?.[name];
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: { queries: { retryDelay: 0 } },
	});
	api.getThemeTokens.mockReset();
	api.getThemeFont.mockReset();
});

afterEach(() => {
	client.clear();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(document, "fonts");
});

describe("useProposalTheme", () => {
	it("makes no request and stays off without the page's hint", () => {
		const { result } = renderTheme(false);

		expect(result.current).toEqual({ active: false });
		expect(api.getThemeTokens).not.toHaveBeenCalled();
	});

	it("wears the neutral paint while the server's answer is pending", () => {
		api.getThemeTokens.mockReturnValue(new Promise(() => {}));
		const { result } = renderTheme();

		expect(result.current.active).toBe(true);
		expect(property(result, "--pa-surface")).toBe(NEUTRAL_THEME.surface);
		expect(property(result, "--pa-ink")).toBe(NEUTRAL_THEME.ink);
		expect(property(result, "--pa-primary")).toBe(NEUTRAL_THEME.primary);
		expect(api.getThemeTokens).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
	});

	it("paints the document's own tokens once the server answers", async () => {
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithPrimary(STYLE_PRIMARY),
		});
		const { result } = renderTheme();

		await waitFor(() =>
			expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
		);
		expect(result.current.active).toBe(true);
		// It reads as text on the paper, so headings wear it too.
		expect(property(result, "--pa-heading")).toBe(STYLE_PRIMARY);
		expect(property(result, "--pa-surface")).toBe(NEUTRAL_THEME.surface);
	});

	it("turns the theme off on a refusal and never asks again", async () => {
		api.getThemeTokens.mockRejectedValue(orpcError("NOT_FOUND"));
		const { result } = renderTheme();

		await waitFor(() => expect(result.current.active).toBe(false));
		expect(result.current.rootProps).toBeUndefined();
		// The client default would retry three times; a refusal is final.
		await act(async () => {
			await new Promise((done) => setTimeout(done, 50));
		});
		expect(api.getThemeTokens).toHaveBeenCalledTimes(1);
	});

	it("asks again before the signed logo reads lapse while the page stays open", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			api.getThemeTokens.mockResolvedValue({
				tokens: tokensWithPrimary(STYLE_PRIMARY),
			});
			const { result } = renderTheme();
			await waitFor(() =>
				expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
			);
			expect(api.getThemeTokens).toHaveBeenCalledTimes(1);

			// The reads last five minutes; the page asks again within them.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
			});

			expect(api.getThemeTokens).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps the same root props when a refetch only signs the logo again", async () => {
		const withLogo = (url: string) => {
			const tokens = tokensWithPrimary(STYLE_PRIMARY);
			return {
				tokens: {
					...tokens,
					proposer: {
						...tokens.proposer,
						logo: { value: { url }, source: "BRAND_KIT" },
					},
				},
			};
		};
		api.getThemeTokens
			.mockResolvedValueOnce(
				withLogo("https://storage.example.com/logo?sig=a"),
			)
			.mockResolvedValue(
				withLogo("https://storage.example.com/logo?sig=b"),
			);
		const { result } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
		);
		const first = result.current.rootProps;

		await act(async () => {
			await client.refetchQueries({
				queryKey: ["projects", "proposalArtifact"],
			});
		});
		await waitFor(() =>
			expect(api.getThemeTokens).toHaveBeenCalledTimes(2),
		);

		// Fresh logo URLs repaint nothing, so the editor beneath is left alone.
		expect(result.current.rootProps).toBe(first);
	});

	it("turns the theme off when the first read fails and nothing is cached", async () => {
		api.getThemeTokens.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR"),
		);
		const { result } = renderTheme();

		// Neutral while the read and its retries are under way, then off: the
		// server never said this document wears the theme.
		expect(result.current.active).toBe(true);
		await waitFor(() => expect(result.current.active).toBe(false));
		expect(result.current.rootProps).toBeUndefined();
		// Not a refusal, so the hook retries before giving up.
		expect(api.getThemeTokens).toHaveBeenCalledTimes(3);
	});

	it("keeps the last paint when a later refetch fails for another reason", async () => {
		api.getThemeTokens.mockResolvedValueOnce({
			tokens: tokensWithPrimary(STYLE_PRIMARY),
		});
		const { result } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
		);

		api.getThemeTokens.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR"),
		);
		await act(async () => {
			await client
				.refetchQueries({ queryKey: ["projects", "proposalArtifact"] })
				.catch(() => undefined);
		});
		await waitFor(() =>
			expect(
				client.getQueryCache().find({
					queryKey: [
						"projects",
						"proposalArtifact",
						"themeTokens",
						PROJECT_ID,
						DOCUMENT_ID,
					],
				})?.state.status,
			).toBe("error"),
		);

		expect(result.current.active).toBe(true);
		expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY);
	});

	it("turns the theme off when the hint is withdrawn, whatever is cached", async () => {
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithPrimary(STYLE_PRIMARY),
		});
		const { result, rerender } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
		);

		rerender({ on: false });

		expect(result.current).toEqual({ active: false });
	});

	it("names the live target and every paint property on a root free of colour utilities", async () => {
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithPrimary(STYLE_PRIMARY),
		});
		const { result } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-primary")).toBe(STYLE_PRIMARY),
		);

		const rootProps = result.current.rootProps;
		expect(rootProps?.className).toBe("proposal-theme");
		expect(rootProps?.["data-proposal-theme"]).toBe("live");
		// The root remaps the app's colour tokens for everything inside it, so
		// a background or text utility on it would repaint it from them.
		expect(rootProps?.className).not.toMatch(/(^|\s)(bg|text)-/);
		expect(Object.keys(rootProps?.style ?? {})).toEqual(
			expect.arrayContaining([
				"--pa-surface",
				"--pa-ink",
				"--pa-heading",
				"--pa-primary",
				"--pa-muted",
				"--pa-border",
				"--pa-font-body",
			]),
		);
	});
});

describe("useProposalTheme uploaded fonts", () => {
	it("reads no font and leaves the families alone without an uploaded file", async () => {
		const { fonts } = installFontLoading();
		api.getThemeTokens.mockResolvedValue({ tokens: tokensWithFonts(null) });
		const { result } = renderTheme();

		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"${DISPLAY_FAMILY}"`,
			),
		);
		expect(property(result, "--pa-font-body")).toBe(`"${BODY_FAMILY}"`);
		expect(api.getThemeFont).not.toHaveBeenCalled();
		expect(fonts.add).not.toHaveBeenCalled();
	});

	it("registers the uploaded file under its alias and names it ahead of the family", async () => {
		const { faces, fonts } = installFontLoading();
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result } = renderTheme();

		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"pa-font-${FONT_FILE_ID}", "${DISPLAY_FAMILY}"`,
			),
		);
		expect(api.getThemeFont).toHaveBeenCalledTimes(1);
		expect(api.getThemeFont).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			slot: "display",
			fileId: FONT_FILE_ID,
		});
		expect(faces).toHaveLength(1);
		// The theme's own name for the file, never the admin's family.
		expect(faces[0]?.family).toBe(`pa-font-${FONT_FILE_ID}`);
		expect([
			...new Uint8Array(faces[0]?.source ?? new ArrayBuffer(0)),
		]).toEqual(WOFF2_BYTES);
		expect(fonts.add).toHaveBeenCalledWith(faces[0]);
		// The body slot has no upload, so its family is as the paint wrote it.
		expect(property(result, "--pa-font-body")).toBe(`"${BODY_FAMILY}"`);
	});

	it("swaps the face when the tokens carry a new file id", async () => {
		const { faces, fonts } = installFontLoading();
		api.getThemeTokens
			.mockResolvedValueOnce({ tokens: tokensWithFonts(FONT_FILE_ID) })
			.mockResolvedValue({ tokens: tokensWithFonts(NEXT_FONT_FILE_ID) });
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"pa-font-${FONT_FILE_ID}", "${DISPLAY_FAMILY}"`,
			),
		);

		// Same family, new upload: nothing the paint writes changes but the id.
		await act(async () => {
			await invalidateProposalTheme(client, PROJECT_ID);
		});

		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"pa-font-${NEXT_FONT_FILE_ID}", "${DISPLAY_FAMILY}"`,
			),
		);
		expect(api.getThemeFont).toHaveBeenLastCalledWith(
			expect.objectContaining({ fileId: NEXT_FONT_FILE_ID }),
		);
		expect(faces.map((face) => face.family)).toEqual([
			`pa-font-${FONT_FILE_ID}`,
			`pa-font-${NEXT_FONT_FILE_ID}`,
		]);
		expect(fonts.delete).toHaveBeenCalledWith(faces[0]);
		expect(fonts.delete).not.toHaveBeenCalledWith(faces[1]);
		expect(fonts.add).toHaveBeenLastCalledWith(faces[1]);
	});

	it("keeps the family and registers nothing when the font is refused", async () => {
		const { faces, fonts } = installFontLoading();
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		api.getThemeFont.mockRejectedValue(orpcError("NOT_FOUND"));
		const { result } = renderTheme();

		await waitFor(() => expect(fontQueryState(FONT_FILE_ID)).toBe("error"));

		expect(property(result, "--pa-font-display")).toBe(
			`"${DISPLAY_FAMILY}"`,
		);
		// A refusal is final, so the read is not retried.
		expect(api.getThemeFont).toHaveBeenCalledTimes(1);
		expect(faces).toHaveLength(0);
		expect(fonts.add).not.toHaveBeenCalled();
	});

	it("keeps the family when the file does not load as a font", async () => {
		const { faces, fonts } = installFontLoading({ loads: false });
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result } = renderTheme();

		await waitFor(() => expect(faces).toHaveLength(1));
		await act(async () => {
			await new Promise((done) => setTimeout(done, 0));
		});

		expect(property(result, "--pa-font-display")).toBe(
			`"${DISPLAY_FAMILY}"`,
		);
		expect(fonts.add).not.toHaveBeenCalled();
	});

	it("removes the face when the page goes", async () => {
		const { faces, fonts } = installFontLoading();
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result, unmount } = renderTheme();
		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"pa-font-${FONT_FILE_ID}", "${DISPLAY_FAMILY}"`,
			),
		);
		expect(fonts.delete).not.toHaveBeenCalled();

		unmount();

		expect(fonts.delete).toHaveBeenCalledTimes(1);
		expect(fonts.delete).toHaveBeenCalledWith(faces[0]);
	});

	it("never registers or names a face that loads only after the page went", async () => {
		const { faces, fonts } = installFontLoading({ loads: "deferred" });
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result, unmount } = renderTheme();
		await waitFor(() => expect(faces).toHaveLength(1));

		unmount();
		await act(async () => {
			faces[0]?.finishLoad();
		});

		expect(fonts.add).not.toHaveBeenCalled();
		expect(property(result, "--pa-font-display")).toBe(
			`"${DISPLAY_FAMILY}"`,
		);
	});

	it("never registers or names the old face when the id changed before it loaded", async () => {
		const { faces, fonts } = installFontLoading({ loads: "deferred" });
		api.getThemeTokens
			.mockResolvedValueOnce({ tokens: tokensWithFonts(FONT_FILE_ID) })
			.mockResolvedValue({ tokens: tokensWithFonts(NEXT_FONT_FILE_ID) });
		api.getThemeFont.mockResolvedValue({
			family: DISPLAY_FAMILY,
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result } = renderTheme();
		await waitFor(() => expect(faces).toHaveLength(1));

		await act(async () => {
			await invalidateProposalTheme(client, PROJECT_ID);
		});
		await waitFor(() => expect(faces).toHaveLength(2));
		await act(async () => {
			faces[0]?.finishLoad();
		});

		expect(fonts.add).not.toHaveBeenCalled();
		expect(property(result, "--pa-font-display")).toBe(
			`"${DISPLAY_FAMILY}"`,
		);

		await act(async () => {
			faces[1]?.finishLoad();
		});
		expect(fonts.add).toHaveBeenCalledTimes(1);
		expect(fonts.add).toHaveBeenCalledWith(faces[1]);
		expect(property(result, "--pa-font-display")).toBe(
			`"pa-font-${NEXT_FONT_FILE_ID}", "${DISPLAY_FAMILY}"`,
		);
	});

	it("never writes a family the theme may not write, nor an unsafe alias", async () => {
		const { faces } = installFontLoading();
		const unsafeFileId = 'font_1"; x';
		const tokens = tokensWithFonts(FONT_FILE_ID);
		const unsafe = {
			...tokens,
			proposer: {
				...tokens.proposer,
				fonts: {
					...tokens.proposer.fonts,
					display: {
						value: 'Evil"; } * { color: red',
						source: "BRAND_KIT",
					},
				},
				fontFiles: {
					display: { value: unsafeFileId, source: "BRAND_KIT" },
					body: { value: null, source: "DEFAULT" },
				},
			},
		};
		api.getThemeTokens.mockResolvedValue({ tokens: unsafe });
		api.getThemeFont.mockResolvedValue({
			family: 'Bad"Family',
			format: "woff2",
			base64: WOFF2_BASE64,
		});
		const { result } = renderTheme();

		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"pa-font-font-1---x", "Inter"`,
			),
		);
		expect(faces[0]?.family).toBe("pa-font-font-1---x");
		const written = JSON.stringify(result.current.rootProps?.style);
		expect(written).not.toContain("Evil");
		expect(written).not.toContain("Bad");
	});

	it("reads no font where the browser cannot register one", async () => {
		api.getThemeTokens.mockResolvedValue({
			tokens: tokensWithFonts(FONT_FILE_ID),
		});
		const { result } = renderTheme();

		await waitFor(() =>
			expect(property(result, "--pa-font-display")).toBe(
				`"${DISPLAY_FAMILY}"`,
			),
		);
		await act(async () => {
			await new Promise((done) => setTimeout(done, 0));
		});

		expect(api.getThemeFont).not.toHaveBeenCalled();
		expect(property(result, "--pa-font-display")).toBe(
			`"${DISPLAY_FAMILY}"`,
		);
	});
});

describe("ProposalThemeStyle", () => {
	it("puts the live stylesheet in the head once, however many roots render it", () => {
		const { container } = render(
			<>
				<ProposalThemeStyle />
				<div>
					<ProposalThemeStyle />
				</div>
			</>,
		);

		const sheets = document.head.querySelectorAll(
			'style[data-href="proposal-theme-live"]',
		);
		expect(sheets).toHaveLength(1);
		expect(sheets[0]?.textContent).toContain(
			'.proposal-theme.proposal-theme[data-proposal-theme="live"]',
		);
		// Hoisted, not left where it was rendered.
		expect(container.querySelector("style")).toBeNull();
	});
});
