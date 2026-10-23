/**
 * DocumentVersionHistory — version authorship rendering.
 *
 * Before U5 this panel rendered the literal string "Editor" for every version
 * that had any `changedBy` at all, so no version ever showed a real author. The
 * server now resolves `author: { kind, name }` and the panel renders it.
 *
 * What these tests pin:
 *  - a human's name renders (not "Editor", not a raw id);
 *  - the auto-refresh agent renders as a NAMED, visually distinct identity — a
 *    different icon AND the brand accent — so it cannot be mistaken for a
 *    teammate (R13);
 *  - a legacy row with no author renders no author line rather than crashing.
 *
 * And Restore (Fizzy #2946): while a run is live, or this tab's regeneration
 * is under way, every Restore control — the row's, the confirm dialog's and
 * the diff viewer's — is closed off and says why, and a refused restore is
 * told in the reader's words, never the server's. A closed-off Restore is
 * `aria-disabled`, not `disabled`: the button itself stays the one tab stop,
 * described by the reason, and pressing it does nothing.
 *
 * And a row's word count is the server's (Fizzy #2946): a diagram fence or an
 * image is no words.
 */

import en from "@repo/i18n/translations/en.json";
import { countDocumentWords } from "@repo/utils/document-word-count";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listVersions = vi.fn();
const restoreVersion = vi.fn(async (_input: unknown): Promise<unknown> => ({}));
const diffViewer = vi.hoisted(() => ({
	props: null as null | {
		onRestore: () => void;
		restoreDisabledReason?: string | null;
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				get: { queryKey: () => ["document"] },
				versions: {
					list: {
						queryOptions: () => ({
							queryKey: ["versions"],
							queryFn: () => listVersions(),
						}),
						queryKey: () => ["versions"],
					},
					restore: {
						mutationOptions: (opts: unknown) => ({
							mutationFn: (input: unknown) =>
								restoreVersion(input),
							...(opts as Record<string, unknown>),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// The shipped English, so a missing key fails here rather than rendering it.
vi.mock("next-intl", async () => {
	const messages = (await import("@repo/i18n/translations/en.json")).default;
	const resolve = (path: string): string => {
		const value = path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				messages,
			);
		if (typeof value !== "string") {
			throw new Error(`missing translation: ${path}`);
		}
		return value;
	};
	return {
		useTranslations: (namespace: string) => (key: string) =>
			resolve(`${namespace}.${key}`),
	};
});

// The real diff viewer drags in TipTap; it is not under test here. What the
// panel hands it is (its own Restore is pinned in VersionDiffViewer.test).
vi.mock("../VersionDiffViewer", () => ({
	VersionDiffViewer: (props: NonNullable<typeof diffViewer.props>) => {
		diffViewer.props = props;
		return null;
	},
}));

import { toast } from "sonner";
import {
	DocumentVersionHistory,
	type RestoreBlockedReason,
} from "../DocumentVersionHistory";

const version = (overrides: Record<string, unknown> = {}) => ({
	id: "ver-1",
	version: 1,
	content: "some words here",
	changeDescription: null,
	changedBy: "user-1",
	author: { kind: "HUMAN", name: "Ada Lovelace" },
	createdAt: "2026-07-01T00:00:00.000Z",
	promptVersion: null,
	...overrides,
});

let queryClient: QueryClient;

const panel = (
	onVersionRestored?: (content: string, version?: number) => void,
	restoreBlockedReason?: RestoreBlockedReason | null,
) => (
	<QueryClientProvider client={queryClient}>
		<DocumentVersionHistory
			open={true}
			onOpenChange={vi.fn()}
			projectId="p1"
			documentId="doc-1"
			currentVersion={3}
			currentContent="current"
			onVersionRestored={onVersionRestored}
			restoreBlockedReason={restoreBlockedReason}
		/>
	</QueryClientProvider>
);

const renderPanel = (
	onVersionRestored?: (content: string, version?: number) => void,
	restoreBlockedReason?: RestoreBlockedReason | null,
) => render(panel(onVersionRestored, restoreBlockedReason));

/** The rendered author line for a given display name. */
const authorLine = (name: string) => screen.getByText(name).closest("span");

/**
 * All rendered text. NOT `render()`'s `container` — the panel is a Radix Sheet,
 * which portals its content to `document.body`, leaving `container` empty. A
 * `container.textContent` assertion here would pass vacuously.
 */
const renderedText = () => document.body.textContent ?? "";

beforeEach(() => {
	vi.clearAllMocks();
	diffViewer.props = null;
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
});

describe("DocumentVersionHistory — author", () => {
	it("renders a human author's name, not the old hardcoded 'Editor'", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({ author: { kind: "HUMAN", name: "Ada Lovelace" } }),
			],
		});

		renderPanel();

		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(screen.queryByText("Editor")).not.toBeInTheDocument();
	});

	it("never renders the raw changedBy id", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "clx0000000rawuserid",
					author: { kind: "HUMAN", name: "Ada Lovelace" },
				}),
			],
		});

		renderPanel();

		await screen.findByText("Ada Lovelace");
		expect(renderedText()).not.toContain("clx0000000rawuserid");
	});

	it("renders the refresh agent by name", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "agent:living-docs-refresh",
					author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
				}),
			],
		});

		renderPanel();

		expect(
			await screen.findByText("Fabric Refresh Agent"),
		).toBeInTheDocument();
	});

	it("distinguishes the agent from a person by icon AND accent, not by name alone", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					id: "ver-2",
					version: 2,
					changedBy: "agent:living-docs-refresh",
					author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
				}),
				version({
					id: "ver-1",
					version: 1,
					author: { kind: "HUMAN", name: "Ada Lovelace" },
				}),
			],
		});

		renderPanel();

		await screen.findByText("Fabric Refresh Agent");

		const agent = authorLine("Fabric Refresh Agent");
		const human = authorLine("Ada Lovelace");

		// Different icon: the agent gets a bot glyph, the person a user glyph.
		expect(agent?.querySelector("svg.lucide-bot")).toBeTruthy();
		expect(agent?.querySelector("svg.lucide-user")).toBeFalsy();
		expect(human?.querySelector("svg.lucide-user")).toBeTruthy();
		expect(human?.querySelector("svg.lucide-bot")).toBeFalsy();

		// Different emphasis: the agent carries the brand accent, the person
		// stays in the muted metadata row.
		expect(agent?.className).toContain("text-primary");
		expect(human?.className).not.toContain("text-primary");

		// The distinction is NOT color-only — the icon above and the name itself
		// both carry it. Guard that the two names never collapse into one label.
		expect(renderedText()).toContain("Ada Lovelace");
		expect(renderedText()).toContain("Fabric Refresh Agent");
	});

	it("renders a legacy version with no author without crashing", async () => {
		listVersions.mockResolvedValue({
			versions: [version({ changedBy: null, author: null, version: 1 })],
		});

		renderPanel();

		// The version row itself still renders...
		expect(await screen.findByText("v1")).toBeInTheDocument();
		// ...with no author line at all (and certainly not the old "Editor").
		expect(screen.queryByText("Editor")).not.toBeInTheDocument();
		expect(document.querySelector("svg.lucide-user")).toBeNull();
		expect(document.querySelector("svg.lucide-bot")).toBeNull();
	});

	it("renders a deleted user's neutral fallback name as given by the server", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "clxdeleted00000000",
					author: { kind: "HUMAN", name: "Unknown user" },
				}),
			],
		});

		renderPanel();

		expect(await screen.findByText("Unknown user")).toBeInTheDocument();
		expect(renderedText()).not.toContain("clxdeleted00000000");
	});
});

describe("DocumentVersionHistory — word count (Fizzy #2946)", () => {
	it("counts a version's words the way the server counts the document's, leaving fences and images out", async () => {
		const content =
			"Intro text here.\n\n```mermaid\ngraph TD; A-->B\n```\n\n![diagram](https://example.com/a.png)\n\nClosing words.";
		const expected = countDocumentWords(content);
		// The plain whitespace split the row used to count with disagrees,
		// so the row tells the two apart.
		expect(expected).not.toBe(content.split(/\s+/).length);
		listVersions.mockResolvedValue({
			versions: [version({ version: 2, content })],
		});

		renderPanel();

		await screen.findByText("v2");
		expect(screen.getByText(`${expected} words`)).toBeInTheDocument();
	});
});

describe("DocumentVersionHistory — restore", () => {
	// The editor guards an accepted assistant proposal with the version its
	// body came from (Fizzy #2589, KTD17); after a restore that is the version
	// the restore was saved as, not the one restored from.
	it("hands the restored content and the version the restore was saved as to onVersionRestored", async () => {
		listVersions.mockResolvedValue({
			versions: [version({ version: 2, content: "earlier words" })],
		});
		restoreVersion.mockResolvedValue({
			document: { id: "doc-1", version: 4, content: "earlier words" },
		});
		const onVersionRestored = vi.fn();

		renderPanel(onVersionRestored);

		await screen.findByText("v2");
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));
		const dialog = await screen.findByRole("dialog", {
			name: "Restore to Version 2?",
		});
		fireEvent.click(
			within(dialog).getByRole("button", { name: "Restore" }),
		);

		await vi.waitFor(() => {
			expect(onVersionRestored).toHaveBeenCalledWith("earlier words", 4);
		});
		expect(restoreVersion).toHaveBeenCalledWith(
			expect.objectContaining({ documentId: "doc-1", versionNumber: 2 }),
		);
	});
});

const BLOCKED_COPY = en.projects.versionHistory.restoreBlocked;
const REFUSAL_COPY = en.projects.documentWriteRefusal;

/**
 * Lets a restore that was (wrongly) started reach its request: a mutation
 * calls its function only after a tick, so asserting at once would pass
 * whether or not anything was started.
 */
const settle = () =>
	act(async () => {
		await new Promise((done) => setTimeout(done, 20));
	});

/**
 * Presses a control the way a keyboard user does: focus it, then each key
 * (Enter, then Space, unless told otherwise). A key reaches the control's
 * own handlers and then the row's around it, and activates the button
 * unless something on the way prevents it.
 */
async function pressWithKeyboard(
	control: HTMLElement,
	keys: readonly string[] = ["{Enter}", " "],
) {
	const user = userEvent.setup();
	act(() => {
		control.focus();
	});
	for (const key of keys) {
		await user.keyboard(key);
	}
}

/** A refusal shaped like the client's thrown oRPC error. */
const refusal = (code: string, dataCode?: string, message = "server words") =>
	Object.assign(new Error(message), {
		code,
		...(dataCode ? { data: { code: dataCode } } : {}),
	});

describe("DocumentVersionHistory — Restore waits for the run (Fizzy #2946)", () => {
	const REASONS = ["runLive", "regenerating"] as const;

	it.each(REASONS)(
		"closes off the row's Restore and says why, on the button itself (%s)",
		async (reason) => {
			listVersions.mockResolvedValue({
				versions: [version({ version: 2 })],
			});

			renderPanel(undefined, reason);

			await screen.findByText("v2");
			const restore = screen.getByRole("button", { name: "Restore" });
			expect(restore).toHaveAttribute("aria-disabled", "true");
			expect(restore).toHaveAccessibleDescription(BLOCKED_COPY[reason]);
			// Still focusable, so a keyboard or screen-reader user reaches it
			// and hears why; and no focusable wrapper around it, which would
			// be a second, nameless tab stop on every row.
			act(() => {
				restore.focus();
			});
			expect(restore).toHaveFocus();
			expect(restore.closest("[tabindex]:not([role])")).toBeNull();
		},
	);

	it("leaves the row's Restore enabled and undescribed with nothing blocking it", async () => {
		listVersions.mockResolvedValue({ versions: [version({ version: 2 })] });

		renderPanel(undefined, null);

		await screen.findByText("v2");
		const restore = screen.getByRole("button", { name: "Restore" });
		expect(restore).toBeEnabled();
		expect(restore).not.toHaveAttribute("aria-disabled");
		expect(restore).not.toHaveAccessibleDescription();
	});

	it("opens neither the confirm nor Compare when the closed-off Restore is clicked", async () => {
		listVersions.mockResolvedValue({ versions: [version({ version: 2 })] });

		renderPanel(undefined, "runLive");

		await screen.findByText("v2");
		fireEvent.click(screen.getByRole("button", { name: "Restore" }));

		expect(diffViewer.props).toBeNull();
		expect(
			screen.queryByRole("dialog", { name: /Restore to Version/ }),
		).not.toBeInTheDocument();
	});

	it("opens neither the confirm nor Compare when the closed-off Restore is pressed with Enter or Space", async () => {
		listVersions.mockResolvedValue({ versions: [version({ version: 2 })] });

		renderPanel(undefined, "regenerating");

		await screen.findByText("v2");
		const restore = screen.getByRole("button", { name: "Restore" });
		// One key at a time: a confirm wrongly opened by Enter would take
		// the focus, and Space would then close it again unseen.
		for (const key of ["{Enter}", " "]) {
			await pressWithKeyboard(restore, [key]);
			expect(diffViewer.props).toBeNull();
			expect(
				screen.queryByRole("dialog", { name: /Restore to Version/ }),
			).not.toBeInTheDocument();
		}
	});

	it("opens the confirm, not Compare, when a keyboard user presses the row's Restore", async () => {
		listVersions.mockResolvedValue({ versions: [version({ version: 2 })] });

		renderPanel(undefined, null);

		await screen.findByText("v2");
		await pressWithKeyboard(
			screen.getByRole("button", { name: "Restore" }),
			["{Enter}"],
		);

		expect(
			await screen.findByRole("dialog", {
				name: "Restore to Version 2?",
			}),
		).toBeInTheDocument();
		expect(diffViewer.props).toBeNull();
	});

	it.each(REASONS)(
		"closes off an open confirm dialog's Restore once a reason arrives (%s)",
		async (reason) => {
			listVersions.mockResolvedValue({
				versions: [version({ version: 2 })],
			});
			const { rerender } = renderPanel();

			await screen.findByText("v2");
			fireEvent.click(screen.getByRole("button", { name: "Restore" }));
			const dialog = await screen.findByRole("dialog", {
				name: "Restore to Version 2?",
			});
			expect(
				within(dialog).getByRole("button", { name: "Restore" }),
			).toBeEnabled();

			// A run starts elsewhere while the dialog is open.
			rerender(panel(undefined, reason));

			const confirm = within(dialog).getByRole("button", {
				name: "Restore",
			});
			expect(confirm).toHaveAttribute("aria-disabled", "true");
			expect(confirm).toHaveAccessibleDescription(BLOCKED_COPY[reason]);
			expect(confirm.closest("[tabindex]:not([role])")).toBeNull();
			fireEvent.click(confirm);
			await pressWithKeyboard(confirm);
			await settle();
			expect(restoreVersion).not.toHaveBeenCalled();
		},
	);

	it.each(REASONS)(
		"hands the diff viewer the reason, and its Restore restores nothing (%s)",
		async (reason) => {
			listVersions.mockResolvedValue({
				versions: [version({ version: 2 })],
			});

			renderPanel(undefined, reason);

			fireEvent.click(await screen.findByText("v2"));
			expect(diffViewer.props?.restoreDisabledReason).toBe(
				BLOCKED_COPY[reason],
			);
			act(() => {
				diffViewer.props?.onRestore();
			});
			await settle();
			expect(restoreVersion).not.toHaveBeenCalled();
		},
	);

	it("lets the diff viewer restore with nothing blocking it", async () => {
		listVersions.mockResolvedValue({ versions: [version({ version: 2 })] });

		renderPanel(undefined, null);

		fireEvent.click(await screen.findByText("v2"));
		expect(diffViewer.props?.restoreDisabledReason).toBeNull();
		act(() => {
			diffViewer.props?.onRestore();
		});
		await vi.waitFor(() => {
			expect(restoreVersion).toHaveBeenCalledWith(
				expect.objectContaining({ versionNumber: 2 }),
			);
		});
	});

	it.each([
		[
			"a live run",
			refusal(
				"CONFLICT",
				"DOCUMENT_GENERATION_IN_PROGRESS",
				"A generation run is writing this document; try again when it finishes.",
			),
			REFUSAL_COPY.runLive,
			true,
		],
		[
			"a write since",
			refusal("CONFLICT", undefined, "Document was modified meanwhile"),
			REFUSAL_COPY.changedMeanwhile,
			true,
		],
		[
			"anything else",
			refusal("FORBIDDEN", undefined, "You don't have access"),
			REFUSAL_COPY.failed,
			false,
		],
	])(
		"tells a restore refused by %s in the reader's words, never the server's",
		async (_label, error, expected, refetchesDocument) => {
			listVersions.mockResolvedValue({
				versions: [version({ version: 2 })],
			});
			restoreVersion.mockRejectedValueOnce(error);
			const invalidate = vi.spyOn(queryClient, "invalidateQueries");

			renderPanel();

			await screen.findByText("v2");
			fireEvent.click(screen.getByRole("button", { name: "Restore" }));
			const dialog = await screen.findByRole("dialog", {
				name: "Restore to Version 2?",
			});
			fireEvent.click(
				within(dialog).getByRole("button", { name: "Restore" }),
			);

			await vi.waitFor(() => {
				expect(toast.error).toHaveBeenCalledWith(expected);
			});
			expect(toast.error).not.toHaveBeenCalledWith(error.message);
			// One a run or another write explains brings the editor up to
			// date with what refused it.
			if (refetchesDocument) {
				expect(invalidate).toHaveBeenCalledWith({
					queryKey: ["document"],
				});
			} else {
				expect(invalidate).not.toHaveBeenCalled();
			}
		},
	);
});
