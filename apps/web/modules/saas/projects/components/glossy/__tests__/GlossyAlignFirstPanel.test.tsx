/**
 * `GlossyAlignFirstPanel` (Fizzy #2589, U14; R24, R25, R33, R34; F2; AE9):
 * Align first's one form — detected opportunities with their reasons, style
 * direction, length, this edition's preparer colors, and the recipient
 * brand — confirmed before anything is generated.
 *
 * Pinned here: everything detected is selected by default and only what the
 * editor keeps is sent; the prefills come from the Brand kit; untouched
 * preparer colors record nothing; a failed website fetch leaves manual entry
 * and still allows the build (AE9); a changed recipient brand is saved to the
 * project against the version read before the build starts, and a conflict
 * stops the build; reasons are plain text.
 *
 * `@tanstack/react-query` is real (the shared recipient fields run their own
 * mutations); the oRPC client is faked. `next-intl` echoes keys with values.
 */

import type { GlossyEdition } from "../../../hooks/use-glossy-edition";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const api = vi.hoisted(() => ({
	fetch: vi.fn(),
	createLogoUploadUrl: vi.fn(),
	update: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			recipientBrand: {
				fetch: (input: unknown) => api.fetch(input),
				createLogoUploadUrl: (input: unknown) =>
					api.createLogoUploadUrl(input),
				update: (input: unknown) => api.update(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => api.toastError(...args) },
}));

vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values && Object.keys(values).length > 0
			? `${key}(${Object.entries(values)
					.map(([name, value]) => `${name}=${String(value)}`)
					.join(", ")})`
			: key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString(),
			number: (value: number) => String(value),
			relativeTime: (date: Date) => date.toISOString(),
		}),
	};
});

import {
	type GlossyAlignFirstOptions,
	GlossyAlignFirstPanel,
	type GlossyDetection,
	type GlossyDetectionState,
} from "../GlossyAlignFirstPanel";
import { glossyEdition, PROJECT_ID } from "./glossy-fixtures";

const CONTENT_HASH = "0123456789abcdef";

function detection(overrides: Partial<GlossyDetection> = {}): GlossyDetection {
	return {
		outcome: "detected",
		contentHash: CONTENT_HASH,
		opportunities: [
			{
				sectionKey: "section-plan",
				heading: "Implementation phases",
				kind: "timeline",
				reason: "Four phases with quarter dates.",
			},
			{
				sectionKey: "section-options",
				heading: "Options",
				kind: "comparison",
				reason: "Two options with trade-offs.",
			},
		],
		fromCache: false,
		degraded: false,
		recipientWebsiteSuggestions: [],
		...overrides,
	};
}

type PanelOptions = {
	state?: GlossyDetectionState;
	brand?: Partial<GlossyEdition["brand"]>;
	lastOptions?: NonNullable<GlossyEdition["edition"]>["lastOptions"];
	draftStale?: boolean;
	hasContent?: boolean;
};

function renderPanel({
	state = { status: "detected", result: detection() },
	brand,
	lastOptions = null,
	draftStale = false,
	hasContent = false,
}: PanelOptions = {}) {
	const onBuild = vi.fn(async (_options: GlossyAlignFirstOptions) => {});
	const onDetectAgain = vi.fn();
	const onRecipientChanged = vi.fn(async () => {});
	const onCancel = vi.fn();
	const edition = glossyEdition({ brand });

	function Harness() {
		const [lengthMode, setLengthMode] = useState<"brief" | "standard">(
			"brief",
		);
		return (
			<GlossyAlignFirstPanel
				projectId={PROJECT_ID}
				detection={state}
				onDetectAgain={onDetectAgain}
				lengthMode={lengthMode}
				onLengthModeChange={setLengthMode}
				brand={edition.brand}
				lastOptions={lastOptions}
				hasContent={hasContent}
				buildBusy={false}
				draftStale={draftStale}
				onBuild={onBuild}
				onRecipientChanged={onRecipientChanged}
				onCancel={onCancel}
			/>
		);
	}

	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const view = render(
		<QueryClientProvider client={client}>
			<Harness />
		</QueryClientProvider>,
	);
	return { ...view, onBuild, onDetectAgain, onRecipientChanged, onCancel };
}

const fetchSpy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	api.update.mockResolvedValue({ outcome: "applied", version: 1 });
	fetchSpy.mockResolvedValue({ ok: true });
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("GlossyAlignFirstPanel", () => {
	it("lists every detected opportunity with its reason, all selected (R24)", () => {
		renderPanel();

		const timeline = screen.getByRole("checkbox", {
			name: "opportunityLabel(kind=visual.kinds.timeline, section=Implementation phases)",
		});
		const comparison = screen.getByRole("checkbox", {
			name: "opportunityLabel(kind=visual.kinds.comparison, section=Options)",
		});
		expect(timeline).toBeChecked();
		expect(comparison).toBeChecked();
		expect(timeline).toHaveAccessibleDescription(
			"Four phases with quarter dates.",
		);
	});

	it("prefills style direction from the Brand kit and defaults to Brief", () => {
		renderPanel();

		expect(screen.getByLabelText("styleDirection")).toHaveValue(
			"Calm and factual.",
		);
		expect(
			screen.getByRole("radio", { name: "toolbar.lengths.brief" }),
		).toBeChecked();
	});

	it("keeps the style direction the last Align first built with, even a cleared one", () => {
		// Cleared and built: recorded as null. The Brand kit guidance must not
		// come back, or the next build changes every extraction key.
		const cleared = renderPanel({
			lastOptions: {
				mode: "align_first",
				lengthMode: "brief",
				styleDirection: null,
				preparerOverrides: null,
			},
		});
		expect(screen.getByLabelText("styleDirection")).toHaveValue("");
		cleared.unmount();

		const kept = renderPanel({
			lastOptions: {
				mode: "align_first",
				lengthMode: "brief",
				styleDirection: "Lead with the timeline",
				preparerOverrides: null,
			},
		});
		expect(screen.getByLabelText("styleDirection")).toHaveValue(
			"Lead with the timeline",
		);
		kept.unmount();

		// Roll the dice records no style direction of its own: the Brand kit
		// guidance is still the prefill.
		renderPanel({
			lastOptions: {
				mode: "roll_the_dice",
				lengthMode: "brief",
				styleDirection: null,
				preparerOverrides: null,
			},
		});
		expect(screen.getByLabelText("styleDirection")).toHaveValue(
			"Calm and factual.",
		);
	});

	it("builds with exactly the confirmed opportunities and the chosen length (F2)", async () => {
		const user = userEvent.setup();
		const { onBuild } = renderPanel();

		await user.click(
			screen.getByRole("checkbox", {
				name: "opportunityLabel(kind=visual.kinds.comparison, section=Options)",
			}),
		);
		await user.click(
			screen.getByRole("radio", { name: "toolbar.lengths.standard" }),
		);
		const style = screen.getByLabelText("styleDirection");
		await user.clear(style);
		await user.type(style, "Lead with the timeline");
		await user.click(screen.getByRole("button", { name: "build" }));

		await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
		expect(onBuild).toHaveBeenCalledWith({
			mode: "align_first",
			lengthMode: "standard",
			styleDirection: "Lead with the timeline",
			preparerOverrides: null,
			detection: {
				contentHash: CONTENT_HASH,
				opportunities: [
					{ sectionKey: "section-plan", kind: "timeline" },
				],
			},
		});
		// Nothing about the recipient changed, so nothing was saved.
		expect(api.update).not.toHaveBeenCalled();
	});

	it("renders a detection reason containing HTML as text (KTD13)", () => {
		const reason = "<script>alert(1)</script><b>bold</b>";
		const { container } = renderPanel({
			state: {
				status: "detected",
				result: detection({
					opportunities: [
						{
							sectionKey: "section-plan",
							heading: "<i>Phases</i>",
							kind: "timeline",
							reason,
						},
					],
				}),
			},
		});

		expect(screen.getByText(reason)).toBeInTheDocument();
		expect(container.querySelector("script")).toBeNull();
		expect(container.querySelector("b")).toBeNull();
		expect(container.querySelector("i")).toBeNull();
	});

	it("keeps manual entry after a failed fetch and still builds (AE9, R34)", async () => {
		const user = userEvent.setup();
		api.fetch.mockResolvedValue({
			outcome: "failed",
			code: "unreachable",
			colors: [],
		});
		const { onBuild, onRecipientChanged } = renderPanel();

		const website = screen.getByLabelText("website");
		await user.type(website, "example.com");
		await user.click(screen.getByRole("button", { name: "fetch" }));

		expect(
			await screen.findByText("failure.unreachable"),
		).toBeInTheDocument();
		// Manual entry stays: logo upload and colors.
		expect(
			screen.getByRole("button", { name: "uploadLogo" }),
		).toBeEnabled();
		const recipientColors = screen.getByRole("group", { name: "colors" });
		expect(
			within(recipientColors).getByRole("button", { name: "addColor" }),
		).toBeEnabled();

		const build = screen.getByRole("button", { name: "build" });
		expect(build).toBeEnabled();
		await user.click(build);

		// The typed website is the one change, saved before the build.
		await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
		expect(api.update).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			expectedVersion: 0,
			name: null,
			website: "example.com",
			colors: [],
			logo: { action: "keep" },
		});
		expect(onRecipientChanged).toHaveBeenCalled();
	});

	it("saves a fetched recipient brand to the project before building (F2, R33)", async () => {
		const user = userEvent.setup();
		api.fetch.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.com",
			token: "t".repeat(32),
			logoUrl: "https://storage.example.com/pending/logo.png?sig=1",
			colors: ["#0d9488"],
		});
		const { onBuild } = renderPanel({
			brand: {
				recipient: {
					name: "Example Corp",
					website: null,
					colors: [],
					logoUrl: null,
					updatedAt: new Date("2026-09-01T10:00:00.000Z"),
				},
				recipientVersion: 3,
			},
		});

		await user.type(screen.getByLabelText("website"), "example.com");
		await user.click(screen.getByRole("button", { name: "fetch" }));
		expect(
			await screen.findByRole("img", { name: "logoAlt" }),
		).toHaveAttribute(
			"src",
			"https://storage.example.com/pending/logo.png?sig=1",
		);

		await user.click(screen.getByRole("button", { name: "build" }));

		await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
		expect(api.update).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			expectedVersion: 3,
			name: "Example Corp",
			website: "https://example.com",
			colors: ["#0d9488"],
			logo: { action: "replace", token: "t".repeat(32) },
		});
		expect(api.update.mock.invocationCallOrder[0]).toBeLessThan(
			onBuild.mock.invocationCallOrder[0],
		);
	});

	it("stops the build and says so when someone else changed the recipient brand", async () => {
		const user = userEvent.setup();
		api.update.mockResolvedValue({ outcome: "conflict" });
		const { onBuild, onRecipientChanged } = renderPanel();

		await user.type(screen.getByLabelText("name"), "Example Corp");
		await user.click(screen.getByRole("button", { name: "build" }));

		expect(
			await screen.findByText("recipientConflict"),
		).toBeInTheDocument();
		expect(onRecipientChanged).toHaveBeenCalledTimes(1);
		expect(onBuild).not.toHaveBeenCalled();
	});

	it("stops the build and shows why when the recipient logo is refused", async () => {
		const user = userEvent.setup();
		api.fetch.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.com",
			token: "t".repeat(32),
			logoUrl: "https://storage.example.com/pending/logo.png?sig=1",
			colors: [],
		});
		api.update.mockResolvedValue({
			outcome: "logoRejected",
			code: "unsupported",
		});
		const { onBuild } = renderPanel();

		await user.type(screen.getByLabelText("website"), "example.com");
		await user.click(screen.getByRole("button", { name: "fetch" }));
		await screen.findByRole("img", { name: "logoAlt" });
		await user.click(screen.getByRole("button", { name: "build" }));

		expect(
			await screen.findByText("logoError.unsupported"),
		).toBeInTheDocument();
		expect(onBuild).not.toHaveBeenCalled();
	});

	it("records preparer colors only when the editor changed them", async () => {
		const user = userEvent.setup();
		const { onBuild } = renderPanel({
			brand: {
				preparer: {
					name: "Example Org",
					logoUrl: null,
					brandColorName: "teal",
					accentColors: ["#1a73e8"],
					guidance: null,
				},
			},
		});

		expect(screen.getByRole("textbox", { name: "primaryHex" })).toHaveValue(
			"#0d9488",
		);
		const accent = screen.getByRole("textbox", {
			name: "accentHex(position=1)",
		});
		expect(accent).toHaveValue("#1a73e8");

		await user.clear(accent);
		await user.type(accent, "#dc2626");
		await user.click(screen.getByRole("button", { name: "build" }));

		await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
		expect(onBuild.mock.calls[0][0].preparerOverrides).toEqual({
			primary: "#0d9488",
			accents: ["#dc2626"],
		});
	});

	it("refuses to build while a color is malformed", async () => {
		const user = userEvent.setup();
		const { onBuild } = renderPanel();

		const primary = screen.getByRole("textbox", { name: "primaryHex" });
		await user.clear(primary);
		await user.type(primary, "not-a-color");
		await user.click(screen.getByRole("button", { name: "build" }));

		expect(await screen.findByText("fixColors")).toBeInTheDocument();
		expect(onBuild).not.toHaveBeenCalled();
	});

	it("proposes websites from the project's links when there is no recipient brand (R33)", async () => {
		const user = userEvent.setup();
		renderPanel({
			state: {
				status: "detected",
				result: detection({
					recipientWebsiteSuggestions: ["https://example.com"],
				}),
			},
		});

		await user.click(
			screen.getByRole("button", {
				name: "useWebsite(website=https://example.com)",
			}),
		);
		expect(screen.getByLabelText("website")).toHaveValue(
			"https://example.com",
		);
	});

	it("says so when detection found nothing, or did not finish, and still builds (R21)", async () => {
		const user = userEvent.setup();
		const { onBuild, unmount } = renderPanel({
			state: {
				status: "detected",
				result: detection({ opportunities: [] }),
			},
		});
		expect(screen.getByText("noOpportunities")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "build" }));
		await waitFor(() => expect(onBuild).toHaveBeenCalledTimes(1));
		expect(onBuild.mock.calls[0][0].detection.opportunities).toEqual([]);
		unmount();

		renderPanel({
			state: {
				status: "detected",
				result: detection({ opportunities: [], degraded: true }),
			},
		});
		expect(screen.getByText("degraded")).toBeInTheDocument();
	});

	it("shows detection in progress, and a failed detection with Detect again", async () => {
		const user = userEvent.setup();
		const { unmount } = renderPanel({ state: { status: "detecting" } });
		expect(screen.getByRole("status")).toHaveTextContent("detecting");
		expect(
			screen.queryByRole("button", { name: "build" }),
		).not.toBeInTheDocument();
		unmount();

		const { onDetectAgain } = renderPanel({ state: { status: "failed" } });
		expect(screen.getByText("detectFailed")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "detectAgain" }));
		expect(onDetectAgain).toHaveBeenCalledTimes(1);
	});

	it("asks for a new detection when the document changed since (draftStale)", async () => {
		const user = userEvent.setup();
		const { onDetectAgain } = renderPanel({
			draftStale: true,
			hasContent: true,
		});

		expect(screen.getByText("draftStale")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "rebuild" })).toBeDisabled();
		await user.click(screen.getByRole("button", { name: "detectAgain" }));
		expect(onDetectAgain).toHaveBeenCalledTimes(1);
	});

	it("moves focus to the form when it opens and closes on Cancel", async () => {
		const user = userEvent.setup();
		const { onCancel } = renderPanel();

		expect(screen.getByRole("heading", { name: "title" })).toHaveFocus();
		await user.click(screen.getByRole("button", { name: "cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("has no axe violations", async () => {
		const { container } = renderPanel({
			state: {
				status: "detected",
				result: detection({
					recipientWebsiteSuggestions: ["https://example.com"],
				}),
			},
		});
		expect(await axe(container)).toHaveNoViolations();
	});

	it("has no axe violations after a failed fetch (AE9)", async () => {
		const user = userEvent.setup();
		api.fetch.mockResolvedValue({
			outcome: "failed",
			code: "no_logo",
			colors: [],
		});
		const { container } = renderPanel();
		await user.type(screen.getByLabelText("website"), "example.com");
		await user.click(screen.getByRole("button", { name: "fetch" }));
		await screen.findByText("failure.no_logo");

		expect(await axe(container)).toHaveNoViolations();
		expect(
			within(container).getByRole("button", { name: "build" }),
		).toBeEnabled();
	});
});
