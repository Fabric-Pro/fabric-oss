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

const api = vi.hoisted(() => ({ getThemeTokens: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getThemeTokens: (input: unknown) => api.getThemeTokens(input),
			},
		},
	},
}));

import {
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
});

afterEach(() => {
	client.clear();
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
