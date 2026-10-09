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

vi.mock("next-intl", async () => {
	const { createTranslator } =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const translators = new Map<string, unknown>();
	return {
		useTranslations: (namespace: string) => {
			if (!translators.has(namespace)) {
				translators.set(
					namespace,
					createTranslator({
						locale: "en",
						messages,
						namespace: namespace as never,
						onError: (error) => {
							throw error;
						},
					}),
				);
			}
			return translators.get(namespace);
		},
		useLocale: () => "en",
	};
});

const api = vi.hoisted(() => ({
	getStyle: vi.fn(),
	updateStyle: vi.fn(),
	getRecipient: vi.fn(),
	updateRecipient: vi.fn(),
	fetchRecipient: vi.fn(),
	createLogoUploadUrl: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			proposalArtifact: {
				getStyle: (input: unknown) => api.getStyle(input),
				updateStyle: (input: unknown) => api.updateStyle(input),
			},
			recipientBrand: {
				get: (input: unknown) => api.getRecipient(input),
				update: (input: unknown) => api.updateRecipient(input),
				fetch: (input: unknown) => api.fetchRecipient(input),
				createLogoUploadUrl: (input: unknown) =>
					api.createLogoUploadUrl(input),
			},
		},
	},
}));

import messages from "@repo/i18n/translations/en.json";
import {
	ProposalStylePanel,
	validateProposalStyleDraft,
} from "@saas/projects/components/proposal-artifact/ProposalStylePanel";
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
		updatedAt: Date;
	}> = {},
) {
	return {
		styleDirection: "Calm and factual",
		primaryColor: "#1a73e8",
		accentColors: ["#ff8800", "#00aa55"],
		updatedAt: new Date("2026-10-07T10:00:00.000Z"),
		...overrides,
	};
}

function savedRecipient(version = 2) {
	return {
		version,
		recipientBrand: {
			name: "Example Corp",
			website: "https://example.com",
			colors: ["#123456"],
			logoUrl: null,
			updatedAt: new Date("2026-09-01T10:00:00.000Z"),
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
	api.getStyle.mockResolvedValue(savedStyle());
	api.getRecipient.mockResolvedValue(savedRecipient());
	api.updateStyle.mockImplementation(
		async (input: {
			styleDirection: string | null;
			primaryColor: string | null;
			accentColors: string[];
		}) => ({
			styleDirection: input.styleDirection,
			primaryColor: input.primaryColor,
			accentColors: input.accentColors,
			updatedAt: new Date("2026-10-07T12:00:00.000Z"),
		}),
	);
});

afterEach(() => {
	client.clear();
});

describe("validateProposalStyleDraft", () => {
	it("trims the direction, normalizes colours and drops blanks", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "  Lead with the timeline  ",
				primary: ["#ABC"],
				accents: ["#FF8800", "", "  "],
			}),
		).toEqual({
			ok: true,
			value: {
				styleDirection: "Lead with the timeline",
				primaryColor: "#aabbcc",
				accentColors: ["#ff8800"],
			},
		});
	});

	it("clears an empty direction and an empty primary", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "   ",
				primary: [],
				accents: [],
			}),
		).toEqual({
			ok: true,
			value: {
				styleDirection: null,
				primaryColor: null,
				accentColors: [],
			},
		});
	});

	it("refuses what the server refuses", () => {
		expect(
			validateProposalStyleDraft({
				styleDirection: "x".repeat(501),
				primary: [],
				accents: [],
			}),
		).toEqual({ ok: false, error: "directionTooLong" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "x".repeat(500),
				primary: [],
				accents: [],
			}).ok,
		).toBe(true);
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: ["red"],
				accents: [],
			}),
		).toEqual({ ok: false, error: "invalidColor" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: [],
				accents: ["#12345g"],
			}),
		).toEqual({ ok: false, error: "invalidColor" });
		expect(
			validateProposalStyleDraft({
				styleDirection: "",
				primary: [],
				accents: ["#111111", "#222222", "#333333", "#444444"],
			}),
		).toEqual({ ok: false, error: "tooManyAccentColors" });
	});
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
			}),
		);
		expect(api.updateRecipient).not.toHaveBeenCalled();
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
});
