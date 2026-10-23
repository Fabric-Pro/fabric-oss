/**
 * `ProposalStylePanel` — the Style tab of a Proposal (Fizzy #2801): style
 * direction, one primary and up to three accent colours, and the project's
 * recipient brand, saved for the NEXT generation.
 *
 * Pinned here: the saved style loads into the form; a save sends exactly the
 * values the server accepts (trimmed direction, lowercase `#rrggbb`, blanks
 * dropped) and only the parts that changed; an invalid colour and a fourth
 * accent are stopped in the browser; the server's validation codes land
 * beside the field; the dirty, saving, saved and error states each say so;
 * the post-save notice offers Regenerate; the recipient brand is labelled as
 * shared by the project's Proposals and confirmed against its version; a
 * viewer reads without controls; a refusal says nothing the server said.
 *
 * Since Fizzy #2946: each proposer value shows its source; an untouched
 * colour saves as inherited (null, `[]`), never as the value it displays;
 * alternatives appear only when a source differs, once per value; the logo,
 * fonts and hero are read-only with who can change them; a recipient
 * website fetch is "not applied" until one field's Confirm, which moves
 * focus and announces itself; its running, timed-out, failed and
 * nothing-found states, its polling, and when it starts on its own; the
 * server's recipient `canEdit`; a sources failure keeps the form editable.
 * Also: the focus after a Confirm waits until it settles; Confirm and Fetch
 * again wait for the fields' own fetch; Confirm sends the version this
 * editor read; a newer recipient version read in the background never
 * replaces unsaved edits; the automatic fetch waits until the tab is shown;
 * a running fetch is read once more just after its lifetime ends.
 *
 * `@tanstack/react-query` is real, and `next-intl` resolves the real en.json,
 * so a missing or renamed string fails the test. axe cannot check colour
 * contrast under jsdom (no canvas); that comes from the design tokens.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

// The reader's locale: English unless a test reads the German copy.
const intl = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const catalogs = {
		en: (await import("@repo/i18n/translations/en.json")).default,
		de: (await import("@repo/i18n/translations/de.json")).default,
	};
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			const key = `${intl.locale}:${namespace}`;
			if (!translators.has(key)) {
				translators.set(
					key,
					createTranslator({
						locale: intl.locale,
						messages: catalogs[intl.locale],
						namespace: namespace as never,
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(key);
		},
		useLocale: () => intl.locale,
	};
});

const api = vi.hoisted(() => ({
	getStyle: vi.fn(),
	updateStyle: vi.fn(),
	getBrandSources: vi.fn(),
	getRecipient: vi.fn(),
	updateRecipient: vi.fn(),
	fetchRecipient: vi.fn(),
	createLogoUploadUrl: vi.fn(),
	requestFetch: vi.fn(),
	confirmSuggestion: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getStyle: (input: unknown) => api.getStyle(input),
				updateStyle: (input: unknown) => api.updateStyle(input),
				getBrandSources: (input: unknown) => api.getBrandSources(input),
			},
			recipientBrand: {
				get: (input: unknown) => api.getRecipient(input),
				update: (input: unknown) => api.updateRecipient(input),
				fetch: (input: unknown) => api.fetchRecipient(input),
				createLogoUploadUrl: (input: unknown) =>
					api.createLogoUploadUrl(input),
				requestFetch: (input: unknown) => api.requestFetch(input),
				confirmSuggestion: (input: unknown) =>
					api.confirmSuggestion(input),
			},
		},
	},
}));

// The active organization's role, for the Brand kit link: nobody's admin
// unless a test says so.
const organization = vi.hoisted(() => ({
	role: null as string | null,
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org-1", slug: "example-org" },
		activeOrganizationUserRole: organization.role,
	}),
}));

import deMessages from "@repo/i18n/translations/de.json";
import messages from "@repo/i18n/translations/en.json";
import { BRAND_FETCH_RUNNING_TTL_MS } from "@repo/utils/proposal-artifact/brand-sources";
import { NEUTRAL_THEME } from "@repo/utils/proposal-artifact/theme-tokens";
import { ProposalStylePanel } from "@saas/projects/components/proposal-artifact/ProposalStylePanel";
import {
	DOCUMENT_ID,
	orpcError,
	PROJECT_ID,
} from "./proposal-artifact-fixtures";

const copy = messages.projects.proposalArtifact.style;
const recipientCopy = messages.projects.glossy.recipientBrand;

function savedStyle(
	overrides: Partial<{
		styleDirection: string | null;
		primaryColor: string | null;
		accentColors: string[];
		autoVisuals: boolean;
		updatedAt: Date;
	}> = {},
) {
	return {
		styleDirection: "Calm and factual",
		primaryColor: "#1a73e8",
		accentColors: ["#ff8800", "#00aa55"],
		autoVisuals: true,
		updatedAt: new Date("2026-10-07T10:00:00.000Z"),
		...overrides,
	};
}

function savedRecipient(version = 2, canEdit = true) {
	return {
		version,
		canEdit,
		recipientBrand: {
			name: "Example Corp",
			website: "https://example.com",
			colors: ["#123456"],
			logoUrl: null,
			updatedAt: new Date("2026-09-01T10:00:00.000Z"),
		},
	};
}

type Source =
	| "MANUAL"
	| "BRAND_KIT"
	| "VENDOR_SITE"
	| "FETCHED_UNCONFIRMED"
	| "DEFAULT";

/** A fetch of the recipient's website; by default one that found what is saved. */
function suggestion(
	overrides: Partial<{
		requestId: string;
		status: "RUNNING" | "SUCCEEDED" | "FAILED";
		failureCode: string | null;
		requestedAt: Date;
		result: {
			name: string | null;
			colors: string[];
			logoUrl: string | null;
			alternatives: Array<"name" | "colors" | "logo">;
		} | null;
	}> = {},
) {
	return {
		requestId: "request-1",
		website: "https://example.com",
		status: "SUCCEEDED" as const,
		failureCode: null,
		requestedAt: new Date(),
		fetchedAt: new Date(),
		result: {
			name: "Example Corp",
			colors: ["#123456"],
			logoUrl: null,
			alternatives: [],
		},
		...overrides,
	};
}

/**
 * Where each value comes from, matching `savedStyle()` and `savedRecipient()`
 * by default: the Style sets both colours, the Brand kit has none of its
 * own, and the recipient website's fetch found what is saved.
 */
function brandSources(
	overrides: Partial<{
		primary: Partial<{
			resolved: { value: string; source: Source };
			style: string | null;
			brandKit: string | null;
			vendorSite: string | null;
			inherited: { value: string; source: Source };
		}>;
		accents: Partial<{
			resolved: { value: string[]; source: Source };
			style: string[];
			brandKit: string[];
			vendorSite: string[];
			inherited: { value: string[]; source: Source };
		}>;
		logo: { source: Source; present: boolean };
		hero: { source: Source; present: boolean };
		recipient: Record<string, unknown> | null;
		suggestion: ReturnType<typeof suggestion> | null;
	}> = {},
) {
	const primary = {
		resolved: { value: "#1a73e8", source: "MANUAL" as Source },
		style: "#1a73e8" as string | null,
		brandKit: null as string | null,
		vendorSite: null as string | null,
		alternatives: [],
		...overrides.primary,
	};
	const accents = {
		resolved: {
			value: ["#ff8800", "#00aa55"],
			source: "MANUAL" as Source,
		},
		style: ["#ff8800", "#00aa55"],
		brandKit: [] as string[],
		vendorSite: [] as string[],
		alternatives: [],
		...overrides.accents,
	};
	return {
		proposer: {
			// What each field holds without the document's override, as the
			// server reads it: the Brand kit, the website, the neutral default.
			primary: {
				inherited: primary.brandKit
					? { value: primary.brandKit, source: "BRAND_KIT" }
					: primary.vendorSite
						? { value: primary.vendorSite, source: "VENDOR_SITE" }
						: {
								value:
									primary.resolved.source === "DEFAULT"
										? primary.resolved.value
										: NEUTRAL_THEME.primary,
								source: "DEFAULT",
							},
				...primary,
			},
			accents: {
				inherited:
					accents.brandKit.length > 0
						? { value: accents.brandKit, source: "BRAND_KIT" }
						: accents.vendorSite.length > 0
							? {
									value: accents.vendorSite,
									source: "VENDOR_SITE",
								}
							: {
									value:
										accents.resolved.source === "DEFAULT"
											? accents.resolved.value
											: [...NEUTRAL_THEME.accents],
									source: "DEFAULT",
								},
				...accents,
			},
			logo: overrides.logo ?? { source: "BRAND_KIT", present: true },
			hero: overrides.hero ?? { source: "DEFAULT", present: false },
			fonts: {
				display: { family: "Lora", source: "BRAND_KIT", hasFile: true },
				body: { family: "Inter", source: "DEFAULT", hasFile: false },
			},
		},
		brandKitWebsite: null,
		siteFetch: null,
		recipient:
			overrides.recipient === null
				? null
				: {
						website: "https://example.com",
						name: "Example Corp",
						colors: ["#123456"],
						hasLogo: false,
						version: 2,
						suggestion:
							overrides.suggestion === undefined
								? suggestion()
								: overrides.suggestion,
						...overrides.recipient,
					},
	};
}

let client: QueryClient;

function renderPanel(
	props: Partial<{
		canEdit: boolean;
		isGenerating: boolean;
		onRegenerate: () => void;
	}> = {},
) {
	return render(
		<QueryClientProvider client={client}>
			<ProposalStylePanel
				projectId={PROJECT_ID}
				documentId={DOCUMENT_ID}
				canEdit={props.canEdit ?? true}
				isGenerating={props.isGenerating ?? false}
				onRegenerate={props.onRegenerate}
			/>
		</QueryClientProvider>,
	);
}

function group(name: string) {
	return screen.getByRole("group", { name });
}

async function loaded() {
	return screen.findByLabelText(copy.styleDirection);
}

beforeEach(() => {
	client = new QueryClient({
		defaultOptions: {
			queries: { retryDelay: 0 },
			mutations: { retry: false },
		},
	});
	for (const fn of Object.values(api)) {
		fn.mockReset();
	}
	organization.role = null;
	intl.locale = "en";
	api.getStyle.mockResolvedValue(savedStyle());
	api.getRecipient.mockResolvedValue(savedRecipient());
	api.getBrandSources.mockResolvedValue(brandSources());
	api.requestFetch.mockResolvedValue({ attempt: null });
	api.updateStyle.mockImplementation(
		async (input: {
			styleDirection: string | null;
			primaryColor: string | null;
			accentColors: string[];
			autoVisuals: boolean;
		}) => ({
			styleDirection: input.styleDirection,
			primaryColor: input.primaryColor,
			accentColors: input.accentColors,
			autoVisuals: input.autoVisuals,
			updatedAt: new Date("2026-10-07T12:00:00.000Z"),
		}),
	);
});

afterEach(() => {
	client.clear();
});

describe("ProposalStylePanel — loading", () => {
	it("loads the saved style into the form", async () => {
		renderPanel();

		const direction = await loaded();
		expect(direction).toHaveValue("Calm and factual");
		expect(direction).toHaveAttribute("maxLength", "500");
		expect(screen.getByText("16 / 500 characters")).toBeInTheDocument();
		expect(screen.getByLabelText(copy.primaryHex)).toHaveValue("#1a73e8");
		expect(screen.getByLabelText("Accent color 1 (hex)")).toHaveValue(
			"#ff8800",
		);
		expect(screen.getByLabelText("Accent color 2 (hex)")).toHaveValue(
			"#00aa55",
		);
		expect(api.getStyle).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
		});
	});

	it("starts empty when nothing is saved, with nothing to save", async () => {
		api.getStyle.mockResolvedValue(null);
		renderPanel();

		expect(await loaded()).toHaveValue("");
		expect(screen.getByText("0 / 500 characters")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.save })).toBeDisabled();
	});

	it("shows a loading state first", async () => {
		api.getStyle.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(await screen.findByText(copy.loading)).toBeInTheDocument();
	});

	it("renders one neutral line on a refusal, nothing the server said", async () => {
		api.getStyle.mockRejectedValue(
			orpcError("FORBIDDEN", "Secret: membership of example-org"),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(copy.unavailable)).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Secret|example-org/);
		expect(screen.queryByLabelText(copy.styleDirection)).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.getStyle).toHaveBeenCalledTimes(1);
	});
});

describe("ProposalStylePanel — saving", () => {
	it("sends validated values and only the style when only the style changed", async () => {
		const user = userEvent.setup();
		api.getStyle.mockResolvedValue(null);
		renderPanel({ onRegenerate: vi.fn() });

		const direction = await loaded();
		await user.type(direction, "  Lead with the timeline  ");
		await user.click(
			within(group(copy.primaryColor)).getByRole("button", {
				name: copy.addColor,
			}),
		);
		await user.type(screen.getByLabelText(copy.primaryHex), "#ABC");
		await user.click(
			within(group(copy.accentColors)).getByRole("button", {
				name: copy.addColor,
			}),
		);
		await user.type(
			screen.getByLabelText("Accent color 1 (hex)"),
			"#FF8800",
		);
		// A blank entry is dropped, not refused.
		await user.click(
			within(group(copy.accentColors)).getByRole("button", {
				name: copy.addColor,
			}),
		);
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.updateStyle).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				documentId: DOCUMENT_ID,
				styleDirection: "Lead with the timeline",
				primaryColor: "#aabbcc",
				accentColors: ["#ff8800"],
				autoVisuals: true,
			}),
		);
		expect(api.updateRecipient).not.toHaveBeenCalled();
	});

	it("refetches the project's Proposal theme once a save settles (Fizzy #2946)", async () => {
		const user = userEvent.setup();
		api.getStyle.mockResolvedValue(null);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		renderPanel({ onRegenerate: vi.fn() });

		await user.type(await loaded(), "Lead with the timeline");
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: [
					"projects",
					"proposalArtifact",
					"themeTokens",
					PROJECT_ID,
				],
			}),
		);
	});

	it("walks through dirty, saving and saved, then offers Regenerate", async () => {
		const user = userEvent.setup();
		const onRegenerate = vi.fn();
		let finish: (value: unknown) => void = () => {};
		api.updateStyle.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		renderPanel({ onRegenerate });

		await loaded();
		const save = screen.getByRole("button", { name: copy.save });
		expect(save).toBeDisabled();
		expect(screen.queryByText(copy.unsaved)).not.toBeInTheDocument();

		await user.type(screen.getByLabelText(copy.styleDirection), ", bold");
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();
		expect(save).toBeEnabled();

		await user.click(save);
		expect(await screen.findByText(copy.saving)).toBeInTheDocument();
		expect(screen.getByLabelText(copy.styleDirection)).toBeDisabled();

		finish(savedStyle({ styleDirection: "Calm and factual, bold" }));
		const notice = await screen.findByText(copy.saved);
		expect(notice.closest('[role="status"]')).not.toBeNull();
		expect(screen.queryByText(copy.unsaved)).not.toBeInTheDocument();
		expect(screen.getByLabelText(copy.styleDirection)).toHaveValue(
			"Calm and factual, bold",
		);

		await user.click(screen.getByRole("button", { name: copy.regenerate }));
		expect(onRegenerate).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(copy.saved)).not.toBeInTheDocument();
	});

	it("offers no Regenerate without a handler", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(await loaded(), "!");
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.regenerate }),
		).not.toBeInTheDocument();
	});

	it("blocks an invalid colour in the browser", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		await user.click(
			within(group(copy.accentColors)).getByRole("button", {
				name: copy.addColor,
			}),
		);
		const third = screen.getByLabelText("Accent color 3 (hex)");
		await user.type(third, "#12345g");
		expect(third).toHaveAttribute("aria-invalid", "true");
		expect(
			within(group(copy.accentColors)).getByText(copy.invalidColor),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: copy.save }));
		expect(
			await screen.findByText(copy.invalid.invalidColor),
		).toBeInTheDocument();
		expect(api.updateStyle).not.toHaveBeenCalled();
	});

	it("never offers a fourth accent", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		const accents = group(copy.accentColors);
		await user.click(
			within(accents).getByRole("button", { name: copy.addColor }),
		);
		expect(
			within(accents).queryByRole("button", { name: copy.addColor }),
		).not.toBeInTheDocument();
		// One primary at most, too.
		expect(
			within(group(copy.primaryColor)).queryByRole("button", {
				name: copy.addColor,
			}),
		).not.toBeInTheDocument();
	});

	it("puts the server's validation code beside the field", async () => {
		const user = userEvent.setup();
		api.updateStyle.mockRejectedValue(
			orpcError("BAD_REQUEST", "The style is not valid", {
				code: "directionTooLong",
			}),
		);
		renderPanel();

		const direction = await loaded();
		await user.type(direction, "!");
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(
			await screen.findByText(
				"Keep the style direction to 500 characters or fewer.",
			),
		).toBeInTheDocument();
		expect(direction).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByRole("alert")).toHaveTextContent(
			copy.invalid.directionTooLong,
		);
	});

	it("says a failed save failed, without the server's text", async () => {
		const user = userEvent.setup();
		api.updateStyle.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Database exploded"),
		);
		const { container } = renderPanel();

		await user.type(await loaded(), "!");
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.styleFailed,
		);
		expect(container).not.toHaveTextContent(/Database exploded/);
		// Still dirty: nothing was saved.
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();
	});

	it("discards unsaved changes", async () => {
		const user = userEvent.setup();
		renderPanel();

		const direction = await loaded();
		await user.type(direction, " and more");
		await user.click(screen.getByRole("button", { name: copy.discard }));

		expect(direction).toHaveValue("Calm and factual");
		expect(screen.getByRole("button", { name: copy.save })).toBeDisabled();
	});
});

describe("ProposalStylePanel — automatic diagrams (Fizzy #2946)", () => {
	function diagramsSwitch() {
		return screen.getByRole("switch", { name: copy.autoVisuals });
	}

	it("shows the switch on, under its own heading, with what it does", async () => {
		renderPanel();

		await loaded();
		expect(
			screen.getByRole("heading", { level: 3, name: copy.diagrams }),
		).toBeInTheDocument();
		expect(diagramsSwitch()).toBeChecked();
		expect(diagramsSwitch()).toHaveAccessibleDescription(
			copy.autoVisualsHelp,
		);
	});

	it("is on when nothing is saved", async () => {
		api.getStyle.mockResolvedValue(null);
		renderPanel();

		await loaded();
		expect(diagramsSwitch()).toBeChecked();
	});

	it("loads a saved off", async () => {
		api.getStyle.mockResolvedValue(savedStyle({ autoVisuals: false }));
		renderPanel();

		await loaded();
		expect(diagramsSwitch()).not.toBeChecked();
	});

	it("turns off through the one Save, dirty until it lands", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		const save = screen.getByRole("button", { name: copy.save });
		expect(save).toBeDisabled();

		await user.click(diagramsSwitch());
		expect(diagramsSwitch()).not.toBeChecked();
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();
		expect(save).toBeEnabled();

		await user.click(save);
		await waitFor(() =>
			expect(api.updateStyle).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				documentId: DOCUMENT_ID,
				styleDirection: "Calm and factual",
				primaryColor: "#1a73e8",
				accentColors: ["#ff8800", "#00aa55"],
				autoVisuals: false,
			}),
		);
		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
		expect(diagramsSwitch()).not.toBeChecked();
		expect(save).toBeDisabled();
		expect(api.updateRecipient).not.toHaveBeenCalled();
	});

	it("is no change once switched back", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		await user.click(diagramsSwitch());
		await user.click(diagramsSwitch());

		expect(screen.queryByText(copy.unsaved)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: copy.save })).toBeDisabled();
	});

	it("keeps a saved off when only the direction changes", async () => {
		const user = userEvent.setup();
		api.getStyle.mockResolvedValue(savedStyle({ autoVisuals: false }));
		renderPanel();

		await user.type(await loaded(), "!");
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.updateStyle).toHaveBeenCalledWith(
				expect.objectContaining({
					styleDirection: "Calm and factual!",
					autoVisuals: false,
				}),
			),
		);
	});

	it("stays off and unsaved when the save fails", async () => {
		const user = userEvent.setup();
		api.updateStyle.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Database exploded"),
		);
		renderPanel();

		await loaded();
		await user.click(diagramsSwitch());
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.styleFailed,
		);
		expect(diagramsSwitch()).not.toBeChecked();
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();
	});

	it("is held while a save runs", async () => {
		const user = userEvent.setup();
		api.updateStyle.mockReturnValue(new Promise(() => {}));
		renderPanel();

		await loaded();
		await user.click(diagramsSwitch());
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(await screen.findByText(copy.saving)).toBeInTheDocument();
		expect(diagramsSwitch()).toBeDisabled();
	});

	it("goes back to the saved value on Discard", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		await user.click(diagramsSwitch());
		await user.click(screen.getByRole("button", { name: copy.discard }));

		expect(diagramsSwitch()).toBeChecked();
		expect(screen.getByRole("button", { name: copy.save })).toBeDisabled();
	});

	it("is read-only for a viewer", async () => {
		api.getStyle.mockResolvedValue(savedStyle({ autoVisuals: false }));
		renderPanel({ canEdit: false });

		await loaded();
		expect(diagramsSwitch()).toBeDisabled();
		expect(diagramsSwitch()).not.toBeChecked();
	});

	it("reads in German", async () => {
		intl.locale = "de";
		const german = deMessages.projects.proposalArtifact.style;
		renderPanel();

		const toggle = await screen.findByRole("switch", {
			name: german.autoVisuals,
		});
		expect(toggle).toBeChecked();
		expect(toggle).toHaveAccessibleDescription(german.autoVisualsHelp);
		expect(
			screen.getByRole("heading", { level: 3, name: german.diagrams }),
		).toBeInTheDocument();
	});
});

describe("ProposalStylePanel — while generating", () => {
	it("says the running job may not use saved changes, and holds Regenerate", async () => {
		const user = userEvent.setup();
		renderPanel({ isGenerating: true, onRegenerate: vi.fn() });

		await loaded();
		expect(screen.getByText(copy.generating)).toBeInTheDocument();

		await user.type(screen.getByLabelText(copy.styleDirection), "!");
		await user.click(screen.getByRole("button", { name: copy.save }));
		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.regenerate }),
		).toBeDisabled();
	});
});

describe("ProposalStylePanel — recipient brand", () => {
	it("is labelled as shared by every Proposal in the project", async () => {
		renderPanel();

		await loaded();
		expect(
			screen.getByRole("heading", { level: 3, name: copy.recipient }),
		).toBeInTheDocument();
		expect(screen.getByText(copy.recipientHelp)).toBeInTheDocument();
		expect(screen.getByLabelText(recipientCopy.name)).toHaveValue(
			"Example Corp",
		);
	});

	it("confirms a changed recipient against the version it was read at, and only that", async () => {
		const user = userEvent.setup();
		api.updateRecipient.mockResolvedValue({
			outcome: "applied",
			version: 3,
		});
		renderPanel();

		await loaded();
		const name = screen.getByLabelText(recipientCopy.name);
		await user.clear(name);
		await user.type(name, "Example Industries");
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.updateRecipient).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				expectedVersion: 2,
				name: "Example Industries",
				website: "https://example.com",
				colors: ["#123456"],
				logo: { action: "keep" },
			}),
		);
		expect(api.updateStyle).not.toHaveBeenCalled();
		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
	});

	it("reloads and says so when someone else confirmed first", async () => {
		const user = userEvent.setup();
		api.updateRecipient.mockResolvedValue({ outcome: "conflict" });
		renderPanel();

		await loaded();
		const name = screen.getByLabelText(recipientCopy.name);
		await user.type(name, " Ltd");
		api.getRecipient.mockResolvedValue({
			...savedRecipient(3),
			recipientBrand: {
				...savedRecipient(3).recipientBrand,
				name: "Their Name",
			},
		});
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(
			await screen.findByText(copy.recipientConflict),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText(recipientCopy.name)).toHaveValue(
				"Their Name",
			),
		);
		expect(screen.queryByText(copy.saved)).not.toBeInTheDocument();
	});

	it("blocks an invalid recipient colour", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		const colour = screen.getByLabelText("Recipient color 1 (hex)");
		await user.clear(colour);
		await user.type(colour, "#zzz");
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(
			await screen.findByText(copy.invalid.invalidColor),
		).toBeInTheDocument();
		expect(api.updateRecipient).not.toHaveBeenCalled();
	});
});

describe("ProposalStylePanel — background refetch", () => {
	it("keeps the form and what is typed through a failed refetch", async () => {
		const user = userEvent.setup();
		renderPanel();

		const direction = await loaded();
		await user.type(direction, " and warm");
		api.getStyle.mockRejectedValue(orpcError("INTERNAL_SERVER_ERROR"));
		await act(() => client.refetchQueries());

		await waitFor(() =>
			expect(api.getStyle.mock.calls.length).toBeGreaterThanOrEqual(4),
		);
		expect(screen.getByLabelText(copy.styleDirection)).toHaveValue(
			"Calm and factual and warm",
		);
		expect(screen.queryByText(copy.loadFailed)).not.toBeInTheDocument();
	});
});

describe("ProposalStylePanel — read-only", () => {
	it("shows the saved style without controls to a viewer", async () => {
		renderPanel({ canEdit: false });

		const direction = await loaded();
		expect(screen.getByText(copy.readOnly)).toBeInTheDocument();
		expect(direction).toBeDisabled();
		expect(screen.getByLabelText(copy.primaryHex)).toBeDisabled();
		expect(
			screen.queryByRole("button", { name: copy.save }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.addColor }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: recipientCopy.fetch }),
		).not.toBeInTheDocument();
	});
});

/** A copy string with its `{host}` filled in. */
function withHost(text: string, host = "example.com") {
	return text.replace("{host}", host);
}

const FOUND = "Found on example.com — not applied";

/** A fetch whose colours differ from the saved `#123456`. */
function foundColors(colors = ["#ff0000"]) {
	return suggestion({
		result: {
			name: "Example Corp",
			colors,
			logoUrl: null,
			alternatives: ["colors"],
		},
	});
}

describe("ProposalStylePanel — proposer sources (Fizzy #2946)", () => {
	it("shows an inherited colour with its source, and saves it as inherited", async () => {
		const user = userEvent.setup();
		api.getStyle.mockResolvedValue(
			savedStyle({ primaryColor: null, accentColors: [] }),
		);
		api.getBrandSources.mockResolvedValue(
			brandSources({
				primary: {
					resolved: { value: "#1f4e79", source: "BRAND_KIT" },
					style: null,
					brandKit: "#1f4e79",
				},
				accents: {
					resolved: { value: ["#475569"], source: "DEFAULT" },
					style: [],
				},
			}),
		);
		renderPanel();

		const primary = await screen.findByText("Uses #1f4e79");
		expect(primary.parentElement).toHaveTextContent(
			`${copy.sourcePrefix} ${copy.sources.brandKit}`,
		);
		expect(
			screen.getByText("Uses #475569").parentElement,
		).toHaveTextContent(copy.sources.default);
		// What resolves is the only value any source holds: no alternative.
		expect(screen.queryByText(/ has #/)).not.toBeInTheDocument();

		// Editing only the direction never saves a displayed inherited value.
		await user.type(screen.getByLabelText(copy.styleDirection), ", bold");
		await user.click(screen.getByRole("button", { name: copy.save }));
		await waitFor(() =>
			expect(api.updateStyle).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				documentId: DOCUMENT_ID,
				styleDirection: "Calm and factual, bold",
				primaryColor: null,
				accentColors: [],
				autoVisuals: true,
			}),
		);
	});

	it("clears a set primary with Use inherited value, shows the source it falls back to, and saves null", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ primary: { brandKit: "#1f4e79" } }),
		);
		renderPanel();

		await loaded();
		expect(await screen.findAllByText(copy.sources.document)).toHaveLength(
			2,
		);
		await user.click(
			screen.getByRole("button", {
				name: "Use inherited value for the primary color: #1f4e79 from Brand kit",
			}),
		);

		expect(
			screen.queryByLabelText(copy.primaryHex),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("Uses #1f4e79").parentElement,
		).toHaveTextContent(copy.sources.brandKit);
		await user.click(screen.getByRole("button", { name: copy.save }));
		await waitFor(() =>
			expect(api.updateStyle).toHaveBeenCalledWith(
				expect.objectContaining({
					primaryColor: null,
					accentColors: ["#ff8800", "#00aa55"],
				}),
			),
		);
	});

	it("offers no alternative when the Style's primary equals the Brand kit's", async () => {
		api.getBrandSources.mockResolvedValue(
			brandSources({ primary: { brandKit: "#1a73e8" } }),
		);
		renderPanel();

		await loaded();
		await screen.findAllByText(copy.sources.document);
		expect(screen.queryByText(/ has #/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Use this/ }),
		).not.toBeInTheDocument();
	});

	it("offers a differing Brand kit value, which Use this copies into the draft", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ primary: { brandKit: "#1f4e79" } }),
		);
		renderPanel();

		await loaded();
		expect(
			await screen.findByText("Brand kit has #1f4e79"),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", {
				name: "Use this for the primary color: #1f4e79 from Brand kit",
			}),
		);

		expect(screen.getByLabelText(copy.primaryHex)).toHaveValue("#1f4e79");
		// The draft holds it now, so the Brand kit no longer differs.
		expect(
			screen.queryByText("Brand kit has #1f4e79"),
		).not.toBeInTheDocument();
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();
		expect(api.updateStyle).not.toHaveBeenCalled();
	});

	it("offers a value the Brand kit and the website share once, under the Brand kit", async () => {
		api.getBrandSources.mockResolvedValue(
			brandSources({
				primary: { brandKit: "#1f4e79", vendorSite: "#1f4e79" },
			}),
		);
		renderPanel();

		await loaded();
		expect(await screen.findAllByText(/ has #1f4e79/)).toHaveLength(1);
		expect(screen.getByText("Brand kit has #1f4e79")).toBeInTheDocument();
	});

	it("compares a typed colour as it would be stored", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ primary: { brandKit: "#1f4e79" } }),
		);
		renderPanel();

		await loaded();
		await screen.findByText("Brand kit has #1f4e79");
		const primary = screen.getByLabelText(copy.primaryHex);
		await user.clear(primary);
		await user.type(primary, "#1F4E79");

		expect(
			screen.queryByText("Brand kit has #1f4e79"),
		).not.toBeInTheDocument();
	});

	it("shows the logo, fonts and hero read-only with their sources, and who changes them", async () => {
		renderPanel();

		await loaded();
		expect(await screen.findByText(copy.logoPresent)).toBeInTheDocument();
		expect(
			screen.getByText("Lora, with its uploaded font file"),
		).toBeInTheDocument();
		expect(screen.getByText("Inter")).toBeInTheDocument();
		expect(screen.getByText(copy.heroMissing)).toBeInTheDocument();
		expect(screen.getByText(copy.askAdmin)).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: copy.changeInBrandKit }),
		).not.toBeInTheDocument();
	});

	it("points an organization admin to the Brand kit", async () => {
		organization.role = "admin";
		renderPanel();

		await loaded();
		expect(
			await screen.findByRole("link", { name: copy.changeInBrandKit }),
		).toHaveAttribute("href", "/app/example-org/settings/general");
		expect(screen.queryByText(copy.askAdmin)).not.toBeInTheDocument();
	});

	it("shows the fields without chips while the sources load", async () => {
		api.getBrandSources.mockReturnValue(new Promise(() => {}));
		renderPanel();

		expect(await loaded()).toBeEnabled();
		expect(screen.getByText(copy.sourcesLoading)).toBeInTheDocument();
		expect(screen.getByLabelText(copy.primaryHex)).toBeEnabled();
		expect(screen.queryByText(/^Source:/)).not.toBeInTheDocument();
	});

	it("keeps the fields editable with Retry when the sources fail", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockRejectedValue(
			orpcError("INTERNAL_SERVER_ERROR", "Database exploded"),
		);
		const { container } = renderPanel();

		expect(await screen.findByText(copy.sourcesFailed)).toBeInTheDocument();
		expect(container).not.toHaveTextContent(/Database exploded/);
		expect(screen.getByLabelText(copy.styleDirection)).toBeEnabled();
		expect(screen.getByLabelText(copy.primaryHex)).toBeEnabled();
		expect(screen.queryByText(/^Source:/)).not.toBeInTheDocument();

		api.getBrandSources.mockResolvedValue(brandSources());
		await user.click(screen.getByRole("button", { name: copy.retry }));
		expect(await screen.findAllByText(copy.sources.document)).toHaveLength(
			2,
		);
		expect(screen.queryByText(copy.sourcesFailed)).not.toBeInTheDocument();
	});
});

describe("ProposalStylePanel — recipient suggestion (Fizzy #2946)", () => {
	it("says each recipient field was set by a person, or not set", async () => {
		renderPanel();

		await loaded();
		expect(
			await screen.findByRole("heading", { name: copy.recipientSources }),
		).toBeInTheDocument();
		// Name, website and colours are saved; the logo is not.
		expect(screen.getAllByText(copy.sources.person)).toHaveLength(3);
		expect(screen.getAllByText(copy.sources.notSet)).toHaveLength(1);
	});

	it("keeps a manual colour, shows the fetched one as not applied, and applies it only on Confirm", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: foundColors() }),
		);
		renderPanel();

		await loaded();
		expect(
			await screen.findByRole("heading", { name: FOUND }),
		).toBeInTheDocument();
		expect(screen.getByText("#ff0000")).toBeInTheDocument();
		expect(screen.getByLabelText("Recipient color 1 (hex)")).toHaveValue(
			"#123456",
		);
		expect(api.confirmSuggestion).not.toHaveBeenCalled();

		api.confirmSuggestion.mockResolvedValue({
			outcome: "applied",
			version: 3,
		});
		api.getRecipient.mockResolvedValue({
			...savedRecipient(3),
			recipientBrand: {
				...savedRecipient(3).recipientBrand,
				colors: ["#ff0000"],
			},
		});
		api.getBrandSources.mockResolvedValue(
			brandSources({
				recipient: { colors: ["#ff0000"], version: 3 },
				suggestion: suggestion({
					result: {
						name: "Example Corp",
						colors: ["#ff0000"],
						logoUrl: null,
						alternatives: [],
					},
				}),
			}),
		);
		await user.click(
			screen.getByRole("button", { name: "Confirm the colors #ff0000" }),
		);

		expect(api.confirmSuggestion).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			expectedVersion: 2,
			requestId: "request-1",
			field: "colors",
		});
		await waitFor(() =>
			expect(
				screen.getByLabelText("Recipient color 1 (hex)"),
			).toHaveValue("#ff0000"),
		);
		expect(
			screen.getByText(withHost(copy.suggestion.applied)),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByLabelText("Recipient color 1 (hex)"),
			).toHaveFocus(),
		);
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: FOUND }),
			).not.toBeInTheDocument(),
		);
		expect(api.updateRecipient).not.toHaveBeenCalled();
	});

	it("shows no card when the fetch found what the recipient brand holds", async () => {
		renderPanel();

		await loaded();
		await screen.findAllByText(copy.sources.person);
		expect(
			screen.queryByRole("heading", { name: FOUND }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Confirm/ }),
		).not.toBeInTheDocument();
		expect(api.requestFetch).not.toHaveBeenCalled();
	});

	it("shows a fetched name in full beside its own Confirm, with no Confirm all", async () => {
		const name =
			"Example Industries International Holdings and Partners of the Northern Region";
		api.getBrandSources.mockResolvedValue(
			brandSources({
				suggestion: suggestion({
					result: {
						name,
						colors: ["#ff0000"],
						logoUrl: null,
						alternatives: ["name", "colors"],
					},
				}),
			}),
		);
		renderPanel();

		expect(await screen.findByText(name)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: `Confirm the name ${name}` }),
		).toBeEnabled();
		expect(
			screen.getAllByRole("button", { name: /^Confirm/ }),
		).toHaveLength(2);
		expect(
			screen.queryByRole("button", { name: /confirm all/i }),
		).not.toBeInTheDocument();
	});

	it("holds every Confirm while one is pending", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({
				suggestion: suggestion({
					result: {
						name: "Example Industries",
						colors: ["#ff0000"],
						logoUrl: null,
						alternatives: ["name", "colors"],
					},
				}),
			}),
		);
		api.confirmSuggestion.mockReturnValue(new Promise(() => {}));
		renderPanel();

		await user.click(
			await screen.findByRole("button", {
				name: "Confirm the name Example Industries",
			}),
		);

		for (const button of screen.getAllByRole("button", {
			name: /^Confirm/,
		})) {
			expect(button).toBeDisabled();
		}
		expect(api.confirmSuggestion).toHaveBeenCalledTimes(1);
	});

	it("holds Confirm while the recipient fields have unsaved changes", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: foundColors() }),
		);
		renderPanel();

		const confirm = await screen.findByRole("button", {
			name: "Confirm the colors #ff0000",
		});
		await user.type(screen.getByLabelText(recipientCopy.name), " Ltd");

		expect(confirm).toBeDisabled();
		expect(confirm).toHaveAccessibleDescription(copy.suggestion.saveFirst);
	});

	it.each([
		["conflict", copy.suggestion.conflict],
		["stale", copy.suggestion.stale],
	] as const)("says a %s confirm applied nothing", async (outcome, text) => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: foundColors() }),
		);
		api.confirmSuggestion.mockResolvedValue({ outcome });
		renderPanel();

		await user.click(
			await screen.findByRole("button", {
				name: "Confirm the colors #ff0000",
			}),
		);

		expect(await screen.findByText(text)).toBeInTheDocument();
		expect(
			screen.queryByText(withHost(copy.suggestion.applied)),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("Recipient color 1 (hex)")).toHaveValue(
			"#123456",
		);
	});

	it("announces a running fetch and polls until it finishes, then stops", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			api.getBrandSources
				.mockResolvedValueOnce(
					brandSources({
						suggestion: suggestion({
							status: "RUNNING",
							result: null,
						}),
					}),
				)
				.mockResolvedValue(brandSources({ suggestion: foundColors() }));
			renderPanel();

			const running = await screen.findByText(
				withHost(copy.suggestion.running),
			);
			expect(running.tagName).toBe("OUTPUT");
			expect(api.getBrandSources).toHaveBeenCalledTimes(1);

			await act(() => vi.advanceTimersByTimeAsync(3100));
			expect(
				await screen.findByRole("heading", { name: FOUND }),
			).toBeInTheDocument();
			const calls = api.getBrandSources.mock.calls.length;
			await act(() => vi.advanceTimersByTimeAsync(10_000));
			expect(api.getBrandSources).toHaveBeenCalledTimes(calls);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads a fetch still running past its lifetime as timed out, without polling, and fetches again on request", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({
				suggestion: suggestion({
					status: "RUNNING",
					requestedAt: new Date(Date.now() - 3 * 60 * 1000),
					result: null,
				}),
			}),
		);
		renderPanel();

		expect(
			await screen.findByText(
				withHost(copy.suggestion.failure.timed_out),
			),
		).toBeInTheDocument();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.getBrandSources).toHaveBeenCalledTimes(1);

		await user.click(
			screen.getByRole("button", { name: copy.suggestion.fetchAgain }),
		);
		expect(api.requestFetch).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			automatic: false,
		});
	});

	it.each([
		["unreachable", withHost(copy.suggestion.failure.unreachable)],
		["no_logo", withHost(copy.suggestion.nothingFound)],
		["rate_limited", copy.suggestion.failure.rate_limited],
	])(
		"says a fetch that failed with %s so, with Fetch again",
		async (code, text) => {
			api.getBrandSources.mockResolvedValue(
				brandSources({
					suggestion: suggestion({
						status: "FAILED",
						failureCode: code,
						result: null,
					}),
				}),
			);
			renderPanel();

			expect((await screen.findByText(text)).tagName).toBe("OUTPUT");
			expect(
				screen.getByRole("button", {
					name: copy.suggestion.fetchAgain,
				}),
			).toBeEnabled();
			expect(screen.getByLabelText(recipientCopy.name)).toBeEnabled();
		},
	);

	it("says nothing was found when a fetch succeeded with nothing in it", async () => {
		api.getBrandSources.mockResolvedValue(
			brandSources({
				suggestion: suggestion({
					result: {
						name: null,
						colors: [],
						logoUrl: null,
						alternatives: [],
					},
				}),
			}),
		);
		renderPanel();

		expect(
			await screen.findByText(withHost(copy.suggestion.nothingFound)),
		).toBeInTheDocument();
	});

	it("says an explicit fetch was refused by the rate limit", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({
				suggestion: suggestion({
					status: "FAILED",
					failureCode: "unreachable",
					result: null,
				}),
			}),
		);
		api.requestFetch.mockRejectedValue(orpcError("TOO_MANY_REQUESTS"));
		renderPanel();

		await user.click(
			await screen.findByRole("button", {
				name: copy.suggestion.fetchAgain,
			}),
		);

		expect(
			await screen.findByText(copy.suggestion.failure.rate_limited),
		).toBeInTheDocument();
	});

	it("fetches the recipient website once when the tab opens on one nobody fetched", async () => {
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: null }),
		);
		renderPanel();

		await loaded();
		await waitFor(() =>
			expect(api.requestFetch).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				automatic: true,
			}),
		);
		await waitFor(() =>
			expect(api.getBrandSources.mock.calls.length).toBeGreaterThan(1),
		);
		expect(api.requestFetch).toHaveBeenCalledTimes(1);
	});

	it("never fetches on its own for someone who cannot change the recipient brand", async () => {
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: null }),
		);
		const viewer = renderPanel({ canEdit: false });
		await screen.findAllByText(copy.sources.person);
		viewer.unmount();
		client.clear();

		// A project guest who edits the project still only reads it.
		api.getRecipient.mockResolvedValue(savedRecipient(2, false));
		renderPanel();
		await screen.findAllByText(copy.sources.person);
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(api.requestFetch).not.toHaveBeenCalled();
	});

	it("fetches a website a save moved", async () => {
		const user = userEvent.setup();
		api.updateRecipient.mockResolvedValue({
			outcome: "applied",
			version: 3,
		});
		renderPanel();

		await loaded();
		const website = screen.getByLabelText(recipientCopy.website);
		await user.clear(website);
		await user.type(website, "example.org");
		api.getRecipient.mockResolvedValue({
			...savedRecipient(3),
			recipientBrand: {
				...savedRecipient(3).recipientBrand,
				website: "https://example.org",
			},
		});
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.requestFetch).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				automatic: true,
			}),
		);
		expect(api.requestFetch).toHaveBeenCalledTimes(1);
	});

	it("does not fetch again a website the fields' own Fetch just filled", async () => {
		const user = userEvent.setup();
		api.fetchRecipient.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.org",
			token: "t".repeat(32),
			logoUrl: null,
			colors: ["#0d9488"],
		});
		api.updateRecipient.mockResolvedValue({
			outcome: "applied",
			version: 3,
		});
		renderPanel();

		await loaded();
		const website = screen.getByLabelText(recipientCopy.website);
		await user.clear(website);
		await user.type(website, "example.org");
		await user.click(
			screen.getByRole("button", { name: recipientCopy.fetch }),
		);
		await waitFor(() =>
			expect(screen.getByLabelText(recipientCopy.website)).toHaveValue(
				"https://example.org",
			),
		);
		api.getRecipient.mockResolvedValue({
			...savedRecipient(3),
			recipientBrand: {
				...savedRecipient(3).recipientBrand,
				website: "https://example.org",
				colors: ["#0d9488"],
			},
		});
		await user.click(screen.getByRole("button", { name: copy.save }));

		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
		expect(api.updateRecipient).toHaveBeenCalledWith(
			expect.objectContaining({
				website: "https://example.org",
				logo: { action: "replace", token: "t".repeat(32) },
			}),
		);
		expect(api.requestFetch).not.toHaveBeenCalled();
	});
});

/** A fetch that found a name and colours differing from what is saved. */
function foundNameAndColors() {
	return suggestion({
		result: {
			name: "Example Industries",
			colors: ["#ff0000"],
			logoUrl: null,
			alternatives: ["name", "colors"],
		},
	});
}

/** The recipient brand as version 3, after someone changed `brand`. */
function recipientV3(
	brand: Partial<ReturnType<typeof savedRecipient>["recipientBrand"]>,
) {
	return {
		...savedRecipient(3),
		recipientBrand: { ...savedRecipient(3).recipientBrand, ...brand },
	};
}

describe("ProposalStylePanel — after a Confirm (Fizzy #2946)", () => {
	it.each([
		[
			"colours",
			"Confirm the colors #ff0000",
			{ colors: ["#ff0000"] },
			() => screen.getByLabelText("Recipient color 1 (hex)"),
			"#ff0000",
		],
		[
			"name",
			"Confirm the name Example Industries",
			{ name: "Example Industries" },
			() => screen.getByLabelText(recipientCopy.name),
			"Example Industries",
		],
	] as const)(
		"focuses the %s field once the Confirm settles, not while its sources are still read",
		async (_field, button, applied, target, value) => {
			const user = userEvent.setup();
			let finishSources: (value: unknown) => void = () => {};
			api.getBrandSources
				.mockResolvedValueOnce(
					brandSources({ suggestion: foundNameAndColors() }),
				)
				.mockReturnValue(
					new Promise((resolve) => {
						finishSources = resolve;
					}),
				);
			api.confirmSuggestion.mockResolvedValue({
				outcome: "applied",
				version: 3,
			});
			renderPanel();

			const confirm = await screen.findByRole("button", { name: button });
			api.getRecipient.mockResolvedValue(recipientV3(applied));
			await user.click(confirm);

			// The new version shows while the sources are re-read: the fields
			// are held still, so the focus waits.
			await waitFor(() => expect(target()).toHaveValue(value));
			expect(target()).toBeDisabled();
			expect(target()).not.toHaveFocus();

			await act(async () => {
				finishSources(
					brandSources({
						recipient: { ...applied, version: 3 },
						suggestion: suggestion(),
					}),
				);
			});
			await waitFor(() => expect(target()).toHaveFocus());
			expect(target()).toBeEnabled();
		},
	);

	it("confirms against the recipient brand this editor read, not the older version the sources compared", async () => {
		const user = userEvent.setup();
		api.getRecipient.mockResolvedValue(savedRecipient(3));
		api.getBrandSources.mockResolvedValue(
			brandSources({
				recipient: { version: 2 },
				suggestion: foundColors(),
			}),
		);
		api.confirmSuggestion.mockResolvedValue({ outcome: "conflict" });
		renderPanel();

		await user.click(
			await screen.findByRole("button", {
				name: "Confirm the colors #ff0000",
			}),
		);

		expect(api.confirmSuggestion).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			expectedVersion: 3,
			requestId: "request-1",
			field: "colors",
		});
	});

	it("holds Confirm and Fetch again while the recipient fields fetch", async () => {
		const user = userEvent.setup();
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: foundColors() }),
		);
		api.fetchRecipient.mockReturnValue(new Promise(() => {}));
		renderPanel();

		const confirm = await screen.findByRole("button", {
			name: "Confirm the colors #ff0000",
		});
		const fetchAgain = screen.getByRole("button", {
			name: copy.suggestion.fetchAgain,
		});
		expect(confirm).toBeEnabled();
		// The fields' own Fetch, on the website as saved: nothing is edited.
		await user.click(
			screen.getByRole("button", { name: recipientCopy.fetch }),
		);

		await waitFor(() => expect(confirm).toBeDisabled());
		expect(fetchAgain).toBeDisabled();
		expect(confirm).not.toHaveAccessibleDescription(
			copy.suggestion.saveFirst,
		);
		expect(api.confirmSuggestion).not.toHaveBeenCalled();
		expect(api.requestFetch).not.toHaveBeenCalled();
	});
});

describe("ProposalStylePanel — the recipient draft (Fizzy #2946)", () => {
	const recipientKey = ["projectRecipientBrand", PROJECT_ID];

	it("keeps edits through a newer version read in the background, and says so when the save meets it", async () => {
		const user = userEvent.setup();
		renderPanel();

		await loaded();
		await user.type(screen.getByLabelText(recipientCopy.name), " Ltd");
		// Another member confirmed the fetched colours meanwhile.
		api.getRecipient.mockResolvedValue(
			recipientV3({ colors: ["#ff0000"] }),
		);
		await act(() => client.invalidateQueries({ queryKey: recipientKey }));
		await waitFor(() => expect(api.getRecipient).toHaveBeenCalledTimes(2));

		expect(screen.getByLabelText(recipientCopy.name)).toHaveValue(
			"Example Corp Ltd",
		);
		expect(screen.getByLabelText("Recipient color 1 (hex)")).toHaveValue(
			"#123456",
		);
		expect(screen.getByText(copy.unsaved)).toBeInTheDocument();

		api.updateRecipient.mockResolvedValue({ outcome: "conflict" });
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.updateRecipient).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedVersion: 2,
					name: "Example Corp Ltd",
				}),
			),
		);
		expect(
			await screen.findByText(copy.recipientConflict),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText(recipientCopy.name)).toHaveValue(
				"Example Corp",
			),
		);
		expect(screen.getByLabelText("Recipient color 1 (hex)")).toHaveValue(
			"#ff0000",
		);
	});

	it("takes a newer version read in the background while the fields hold no edits", async () => {
		renderPanel();

		await loaded();
		api.getRecipient.mockResolvedValue(recipientV3({ name: "Their Name" }));
		await act(() => client.invalidateQueries({ queryKey: recipientKey }));

		await waitFor(() =>
			expect(screen.getByLabelText(recipientCopy.name)).toHaveValue(
				"Their Name",
			),
		);
		expect(screen.queryByText(copy.unsaved)).not.toBeInTheDocument();
	});

	it("fetches a moved website on save once Discard dropped what the fields' own Fetch filled", async () => {
		const user = userEvent.setup();
		api.fetchRecipient.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.org",
			token: "t".repeat(32),
			logoUrl: null,
			colors: ["#0d9488"],
		});
		api.updateRecipient.mockResolvedValue({
			outcome: "applied",
			version: 3,
		});
		renderPanel();

		await loaded();
		const website = () => screen.getByLabelText(recipientCopy.website);
		await user.clear(website());
		await user.type(website(), "example.org");
		await user.click(
			screen.getByRole("button", { name: recipientCopy.fetch }),
		);
		await waitFor(() =>
			expect(website()).toHaveValue("https://example.org"),
		);
		await user.click(screen.getByRole("button", { name: copy.discard }));
		expect(website()).toHaveValue("https://example.com");

		// Typed by hand this time: nothing has fetched it for this draft.
		await user.clear(website());
		await user.type(website(), "example.org");
		api.getRecipient.mockResolvedValue(
			recipientV3({ website: "https://example.org" }),
		);
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() =>
			expect(api.requestFetch).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				automatic: true,
			}),
		);
	});
});

describe("ProposalStylePanel — when the recipient fetch starts on its own (Fizzy #2946)", () => {
	/** A stand-in observer the test tells whether the panel is on screen. */
	function installIntersectionObserver() {
		const observers: Array<{
			callback: IntersectionObserverCallback;
			targets: Element[];
		}> = [];
		class FakeIntersectionObserver {
			readonly targets: Element[] = [];
			constructor(readonly callback: IntersectionObserverCallback) {
				observers.push(this);
			}
			observe(target: Element) {
				this.targets.push(target);
			}
			unobserve() {}
			disconnect() {}
			takeRecords() {
				return [];
			}
		}
		vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
		return (isIntersecting: boolean) =>
			act(() => {
				for (const observer of observers) {
					observer.callback(
						observer.targets.map(
							(target) =>
								({
									isIntersecting,
									target,
								}) as IntersectionObserverEntry,
						),
						observer as unknown as IntersectionObserver,
					);
				}
			});
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("waits until the tab is shown, then fetches once", async () => {
		const show = installIntersectionObserver();
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: null }),
		);
		renderPanel();

		await loaded();
		// Another tab is active: the Style panel is hidden.
		show(false);
		await screen.findAllByText(copy.sources.person);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.requestFetch).not.toHaveBeenCalled();

		show(true);
		await waitFor(() =>
			expect(api.requestFetch).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				automatic: true,
			}),
		);
		show(false);
		show(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.requestFetch).toHaveBeenCalledTimes(1);
	});
});

describe("ProposalStylePanel — a fetch past its lifetime (Fizzy #2946)", () => {
	it("reads the sources once more just after a running fetch's lifetime ends, so it shows as timed out", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			// One second of its lifetime left: the next poll is three away.
			const requestedAt = new Date(
				Date.now() - BRAND_FETCH_RUNNING_TTL_MS + 1000,
			);
			api.getBrandSources
				.mockResolvedValueOnce(
					brandSources({
						suggestion: suggestion({
							status: "RUNNING",
							requestedAt,
							result: null,
						}),
					}),
				)
				.mockResolvedValue(
					brandSources({
						suggestion: suggestion({
							status: "FAILED",
							failureCode: "timed_out",
							requestedAt,
							result: null,
						}),
					}),
				);
			renderPanel();

			expect(
				await screen.findByText(withHost(copy.suggestion.running)),
			).toBeInTheDocument();
			expect(api.getBrandSources).toHaveBeenCalledTimes(1);

			await act(() => vi.advanceTimersByTimeAsync(2200));
			await act(() => vi.advanceTimersByTimeAsync(0));

			expect(api.getBrandSources).toHaveBeenCalledTimes(2);
			expect(
				screen.getByText(withHost(copy.suggestion.failure.timed_out)),
			).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ProposalStylePanel — who edits (Fizzy #2946)", () => {
	it("lets a project admin without an organization admin role save the Style", async () => {
		const user = userEvent.setup();
		organization.role = "member";
		renderPanel({ canEdit: true });

		await user.type(await loaded(), "!");
		await user.click(screen.getByRole("button", { name: copy.save }));

		await waitFor(() => expect(api.updateStyle).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(copy.saved)).toBeInTheDocument();
	});

	it("shows someone the server does not let change the recipient brand its fields read-only, with the reason", async () => {
		api.getRecipient.mockResolvedValue(savedRecipient(2, false));
		api.getBrandSources.mockResolvedValue(
			brandSources({ suggestion: foundColors() }),
		);
		renderPanel();

		await loaded();
		expect(screen.getByLabelText(recipientCopy.name)).toBeDisabled();
		expect(screen.getByText(recipientCopy.membersOnly)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: recipientCopy.fetch }),
		).not.toBeInTheDocument();
		// The suggestion reads, but nothing in it can be applied from here.
		expect(
			await screen.findByRole("heading", { name: FOUND }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^Confirm/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: copy.suggestion.fetchAgain }),
		).not.toBeInTheDocument();
		// The Style itself stays theirs to change.
		expect(screen.getByLabelText(copy.styleDirection)).toBeEnabled();
	});
});

describe("ProposalStylePanel — accessibility", () => {
	it("has no axe violations — editable, after a refused save, and read-only", async () => {
		const user = userEvent.setup();
		const editable = renderPanel({ isGenerating: true });
		await loaded();
		expect(await axe(editable.container)).toHaveNoViolations();

		await user.click(
			within(group(copy.accentColors)).getByRole("button", {
				name: copy.addColor,
			}),
		);
		await user.type(screen.getByLabelText("Accent color 3 (hex)"), "#zz");
		await user.click(screen.getByRole("button", { name: copy.save }));
		await screen.findByText(copy.invalid.invalidColor);
		expect(await axe(editable.container)).toHaveNoViolations();
		editable.unmount();

		const readOnly = renderPanel({ canEdit: false });
		await loaded();
		expect(await axe(readOnly.container)).toHaveNoViolations();
	});

	it("has no axe violations with sources, alternatives and a suggestion to confirm (Fizzy #2946)", async () => {
		organization.role = "owner";
		api.getBrandSources.mockResolvedValue(
			brandSources({
				primary: { brandKit: "#1f4e79", vendorSite: "#2a9d8f" },
				suggestion: suggestion({
					result: {
						name: "Example Industries",
						colors: ["#ff0000"],
						logoUrl:
							"https://storage.example.com/suggested.png?sig=1",
						alternatives: ["name", "colors", "logo"],
					},
				}),
			}),
		);
		const { container } = renderPanel();

		await screen.findByRole("heading", { name: FOUND });
		expect(
			screen.getByRole("img", { name: "Logo found on example.com" }),
		).toBeInTheDocument();
		expect(await axe(container)).toHaveNoViolations();
	});
});
