/**
 * `InstructionsCompareDialog` and the `InstructionFileDiff` it mounts.
 *
 * The contract under test is WHEN bytes are read: the comparison itself is a
 * manifest, and `getFile` must not be called for a row nobody expanded, for a
 * binary file, or for a script before its "Show diff" button is pressed. The
 * mock below records every `getFile` input so those are assertions rather
 * than claims.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		return node && typeof node === "object"
			? (node as Record<string, unknown>)[key]
			: undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		return Object.entries(values ?? {}).reduce(
			(out, [name, value]) => out.replaceAll(`{${name}}`, String(value)),
			raw,
		);
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
}));

const state = vi.hoisted(() => ({
	comparison: null as Record<string, unknown> | null,
	compareError: null as Error | null,
	bodies: new Map<string, Record<string, unknown>>(),
	getFileCalls: [] as Array<Record<string, unknown>>,
	fileError: null as Error | null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				compare: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["compare", input],
						queryFn: async () => {
							if (state.compareError) {
								throw state.compareError;
							}
							return state.comparison;
						},
					}),
				},
				getFile: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["getFile", input],
						queryFn: async () => {
							state.getFileCalls.push(
								input as Record<string, unknown>,
							);
							if (state.fileError) {
								throw state.fileError;
							}
							const { snapshotId, path } = input as {
								snapshotId: string;
								path: string;
							};
							return (
								state.bodies.get(`${snapshotId}:${path}`) ?? {
									body: "",
									truncated: false,
								}
							);
						},
					}),
				},
			},
		},
	},
}));

import { InstructionsCompareDialog } from "../InstructionsCompareDialog";

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}

function comparison(overrides: Record<string, unknown> = {}) {
	return {
		from: { id: "s7", version: 7 },
		to: { id: "s8", version: 8 },
		added: [{ path: "new.md", kind: "KNOWLEDGE", isText: true, size: 10 }],
		removed: [{ path: "gone.md", kind: "RULE", isText: true, size: 4 }],
		changed: [
			{
				path: "AGENTS.md",
				kind: "INSTRUCTIONS",
				isText: true,
				fromSize: 8,
				toSize: 7,
			},
		],
		unchangedCount: 12,
		...overrides,
	};
}

function dialogElement(props: Record<string, unknown> = {}) {
	return (
		<InstructionsCompareDialog
			projectId="p"
			fromSnapshotId="s7"
			toSnapshotId="s8"
			publishedSide="from"
			open
			onOpenChange={() => undefined}
			{...props}
		/>
	);
}

function renderDialog(props: Record<string, unknown> = {}) {
	return render(dialogElement(props), { wrapper: Wrapper });
}

/**
 * Render against a client the test holds, so it can seed the SECOND pair's
 * answer before switching to it. That is what makes the switch observable:
 * with the answer already cached, `data` never goes undefined and the groups
 * are never unmounted, so only an explicit remount resets what is expanded.
 * Without the seed the pending state unmounts them anyway and the assertion
 * would pass against the unfixed component.
 */
function renderWithSeededClient(props: Record<string, unknown> = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			{dialogElement(props)}
		</QueryClientProvider>,
	);
	return {
		/** Pre-load a pair's comparison so switching to it is instant. */
		seed(
			input: { fromSnapshotId: string; toSnapshotId: string },
			value: unknown,
		) {
			client.setQueryData(
				["compare", { projectId: "p", ...input }],
				value,
			);
		},
		/** Re-render the same tree under the same client. */
		show(next: Record<string, unknown>) {
			view.rerender(
				<QueryClientProvider client={client}>
					{dialogElement(next)}
				</QueryClientProvider>,
			);
		},
	};
}

beforeEach(() => {
	state.comparison = comparison();
	state.compareError = null;
	state.fileError = null;
	state.bodies = new Map([
		["s7:AGENTS.md", { body: "# Before\n", truncated: false }],
		["s8:AGENTS.md", { body: "# After\n", truncated: false }],
	]);
	state.getFileCalls = [];
});

describe("InstructionsCompareDialog", () => {
	it("summarizes the comparison and lists each group without reading any file", async () => {
		renderDialog();

		expect(
			await screen.findByText(
				"1 added, 1 removed, 1 changed, 12 unchanged",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Version 7 (published) → version 8"),
		).toBeInTheDocument();
		expect(screen.getByText("new.md")).toBeInTheDocument();
		expect(screen.getByText("gone.md")).toBeInTheDocument();
		expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
		// Nothing is expanded yet, so no body has been fetched.
		expect(state.getFileCalls).toHaveLength(0);
	});

	it("names the published side of the pair from the caller's direction", async () => {
		renderDialog({ publishedSide: "to" });
		expect(
			await screen.findByText("Version 7 → version 8 (published)"),
		).toBeInTheDocument();
	});

	it("fetches both sides and renders a unified diff only once a changed row is expanded", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);

		expect(await screen.findByText(/- # Before/)).toBeInTheDocument();
		expect(screen.getByText(/\+ # After/)).toBeInTheDocument();
		expect(screen.getByText("+1 −1")).toBeInTheDocument();
		await waitFor(() => expect(state.getFileCalls).toHaveLength(2));
		expect(state.getFileCalls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					snapshotId: "s7",
					path: "AGENTS.md",
					maxLength: 200_000,
				}),
				expect.objectContaining({
					snapshotId: "s8",
					path: "AGENTS.md",
					maxLength: 200_000,
				}),
			]),
		);
	});

	it("offers no expansion for an added or a removed row", async () => {
		renderDialog();
		await screen.findByText("new.md");

		expect(screen.queryByRole("button", { name: /new\.md/ })).toBeNull();
		expect(screen.queryByRole("button", { name: /gone\.md/ })).toBeNull();
	});

	it("says a binary file changed instead of reading its bytes", async () => {
		const user = userEvent.setup();
		state.comparison = comparison({
			changed: [
				{
					path: "logo.png",
					kind: "OTHER",
					isText: false,
					fromSize: 90,
					toSize: 120,
				},
			],
		});
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /logo\.png/ }),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.binaryChanged,
			),
		).toBeInTheDocument();
		expect(state.getFileCalls).toHaveLength(0);
	});

	it.each(["SCRIPT", "SETTINGS"] as const)(
		"withholds a %s diff until it is asked for",
		async (kind) => {
			const user = userEvent.setup();
			state.comparison = comparison({
				changed: [
					{
						path: "run.sh",
						kind,
						isText: true,
						fromSize: 8,
						toSize: 9,
					},
				],
			});
			state.bodies = new Map([
				["s7:run.sh", { body: "echo old\n", truncated: false }],
				["s8:run.sh", { body: "echo new\n", truncated: false }],
			]);
			renderDialog();

			await user.click(
				await screen.findByRole("button", { name: /run\.sh/ }),
			);
			expect(state.getFileCalls).toHaveLength(0);

			await user.click(
				screen.getByRole("button", {
					name: en.projects.codingInstructions.compare.showDiffButton,
				}),
			);
			expect(await screen.findByText(/- echo old/)).toBeInTheDocument();
			await waitFor(() => expect(state.getFileCalls).toHaveLength(2));
		},
	);

	it("warns that a truncated body only shows the start of the file", async () => {
		const user = userEvent.setup();
		state.bodies = new Map([
			["s7:AGENTS.md", { body: "# Before\n", truncated: false }],
			["s8:AGENTS.md", { body: "# After\n", truncated: true }],
		]);
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.diffTruncated,
			),
		).toBeInTheDocument();
	});

	/**
	 * The manifest already said this file changed — that is why the row
	 * exists. With a truncated side, "the text did not change" contradicts
	 * that and sends a reviewer away believing the file is untouched; only
	 * the part that was loaded is unchanged.
	 */
	it("does not claim a truncated file is unchanged when its loaded prefix matches", async () => {
		const user = userEvent.setup();
		state.bodies = new Map([
			["s7:AGENTS.md", { body: "# Same\n", truncated: true }],
			["s8:AGENTS.md", { body: "# Same\n", truncated: true }],
		]);
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.noChangesInLoadedPrefix,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				en.projects.codingInstructions.compare.noTextualChanges,
			),
		).toBeNull();
	});

	it("says the text is unchanged only when neither side was truncated", async () => {
		const user = userEvent.setup();
		state.bodies = new Map([
			["s7:AGENTS.md", { body: "# Same\n", truncated: false }],
			["s8:AGENTS.md", { body: "# Same\n", truncated: true }],
		]);
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);
		// One truncated side is enough to withhold the stronger claim.
		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.noChangesInLoadedPrefix,
			),
		).toBeInTheDocument();
	});

	/**
	 * The dialog can stay mounted while the pair it compares changes — the
	 * published view holds it open and the published pointer moves under it.
	 * Expansion keyed by path alone survived that, so the same path in the
	 * NEW pair arrived already open, fetching two bodies nobody asked for.
	 */
	describe("when the compared pair changes underneath it", () => {
		it("collapses the same path again and fetches nothing until it is reopened", async () => {
			const user = userEvent.setup();
			const secondPair = comparison({
				from: { id: "s8", version: 8 },
				to: { id: "s9", version: 9 },
			});
			const { seed, show } = renderWithSeededClient();

			await user.click(
				await screen.findByRole("button", { name: /AGENTS\.md/ }),
			);
			await waitFor(() => expect(state.getFileCalls).toHaveLength(2));

			// The published pointer moved: v8 -> v9 is now the pair, and its
			// answer is already cached, so the groups are never unmounted by a
			// pending state on the way there.
			seed({ fromSnapshotId: "s8", toSnapshotId: "s9" }, secondPair);
			state.comparison = secondPair;
			state.bodies = new Map([
				["s8:AGENTS.md", { body: "# Eight\n", truncated: false }],
				["s9:AGENTS.md", { body: "# Nine\n", truncated: false }],
			]);
			show({ fromSnapshotId: "s8", toSnapshotId: "s9" });

			expect(
				await screen.findByText("Version 8 (published) → version 9"),
			).toBeInTheDocument();
			const row = screen.getByRole("button", { name: /AGENTS\.md/ });
			expect(row).toHaveAttribute("aria-expanded", "false");
			// Still the two calls from the first pair, none for the new one.
			expect(state.getFileCalls).toHaveLength(2);

			await user.click(row);
			expect(await screen.findByText(/- # Eight/)).toBeInTheDocument();
			await waitFor(() => expect(state.getFileCalls).toHaveLength(4));
			expect(state.getFileCalls.slice(2)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						snapshotId: "s8",
						path: "AGENTS.md",
					}),
					expect.objectContaining({
						snapshotId: "s9",
						path: "AGENTS.md",
					}),
				]),
			);
		});

		it("asks again before showing a script's diff for the new pair", async () => {
			const user = userEvent.setup();
			const scriptRow = {
				path: "run.sh",
				kind: "SCRIPT",
				isText: true,
				fromSize: 8,
				toSize: 9,
			};
			state.comparison = comparison({ changed: [scriptRow] });
			state.bodies = new Map([
				["s7:run.sh", { body: "echo old\n", truncated: false }],
				["s8:run.sh", { body: "echo new\n", truncated: false }],
			]);
			const { seed, show } = renderWithSeededClient();

			await user.click(
				await screen.findByRole("button", { name: /run\.sh/ }),
			);
			await user.click(
				screen.getByRole("button", {
					name: en.projects.codingInstructions.compare.showDiffButton,
				}),
			);
			await waitFor(() => expect(state.getFileCalls).toHaveLength(2));

			const secondPair = comparison({
				from: { id: "s8", version: 8 },
				to: { id: "s9", version: 9 },
				changed: [scriptRow],
			});
			seed({ fromSnapshotId: "s8", toSnapshotId: "s9" }, secondPair);
			state.comparison = secondPair;
			state.bodies = new Map([
				["s8:run.sh", { body: "echo eight\n", truncated: false }],
				["s9:run.sh", { body: "echo nine\n", truncated: false }],
			]);
			show({ fromSnapshotId: "s8", toSnapshotId: "s9" });
			expect(
				await screen.findByText("Version 8 (published) → version 9"),
			).toBeInTheDocument();

			// Reopening the row does NOT carry the old pair's consent over.
			await user.click(screen.getByRole("button", { name: /run\.sh/ }));
			expect(
				await screen.findByRole("button", {
					name: en.projects.codingInstructions.compare.showDiffButton,
				}),
			).toBeInTheDocument();
			expect(state.getFileCalls).toHaveLength(2);

			await user.click(
				screen.getByRole("button", {
					name: en.projects.codingInstructions.compare.showDiffButton,
				}),
			);
			expect(await screen.findByText(/- echo eight/)).toBeInTheDocument();
			await waitFor(() => expect(state.getFileCalls).toHaveLength(4));
		});
	});

	it("says there are no textual changes when both bodies are identical", async () => {
		const user = userEvent.setup();
		state.bodies = new Map([
			["s7:AGENTS.md", { body: "# Same\n", truncated: false }],
			["s8:AGENTS.md", { body: "# Same\n", truncated: false }],
		]);
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.noTextualChanges,
			),
		).toBeInTheDocument();
	});

	it("surfaces a failure to read one side of an expanded file", async () => {
		const user = userEvent.setup();
		state.fileError = new Error("offline");
		renderDialog();

		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			en.projects.codingInstructions.compare.diffError,
		);
	});

	it("states plainly when two versions hold the same files", async () => {
		state.comparison = comparison({
			added: [],
			removed: [],
			changed: [],
			unchangedCount: 14,
		});
		renderDialog();

		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.noDifferences,
			),
		).toBeInTheDocument();
	});

	it("reports a comparison that could not be loaded", async () => {
		state.compareError = new Error("gone");
		renderDialog();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			en.projects.codingInstructions.compare.loadError,
		);
	});
});
