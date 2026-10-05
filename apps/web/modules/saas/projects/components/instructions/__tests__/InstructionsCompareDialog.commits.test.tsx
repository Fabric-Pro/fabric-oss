/**
 * `InstructionsCompareDialog` on a repository-backed project (Fizzy #2878
 * §10): what changed between two commits of the synced branch, within the
 * synced folder. The comparison is a list of names; a file's text is read only
 * for a changed row somebody expands, through `readCommitFile`, and a side
 * Fabric will not show (withheld, not text, too large) is one plain line rather
 * than a diff.
 *
 * Every `readCommitFile` input is recorded so "which bytes were asked for" is
 * an assertion, and the snapshot procedures are made to fail so a commit
 * comparison that reached for them would show.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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
	compareCalls: [] as Array<Record<string, unknown>>,
	files: new Map<string, Record<string, unknown>>(),
	readCalls: [] as Array<Record<string, unknown>>,
	snapshotCalls: [] as string[],
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				compare: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["compare", input],
						queryFn: async () => {
							state.snapshotCalls.push("compare");
							return null;
						},
					}),
				},
				getFile: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["getFile", input],
						queryFn: async () => {
							state.snapshotCalls.push("getFile");
							return null;
						},
					}),
				},
				repositorySync: {
					compareCommits: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["compareCommits", input],
							queryFn: async () => {
								state.compareCalls.push(
									input as Record<string, unknown>,
								);
								if (state.compareError) {
									throw state.compareError;
								}
								return state.comparison;
							},
						}),
					},
					readCommitFile: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["readCommitFile", input],
							queryFn: async () => {
								state.readCalls.push(
									input as Record<string, unknown>,
								);
								const { sha, path } = input as {
									sha: string;
									path: string;
								};
								return (
									state.files.get(`${sha}:${path}`) ?? {
										state: "absent",
									}
								);
							},
						}),
					},
				},
			},
		},
	},
}));

import { InstructionsCompareDialog } from "../InstructionsCompareDialog";

const PARENT = "9a8b7c6d5e4f30211203948576a6b5c4d3e2f101";
const COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

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
		from: { sha: PARENT },
		to: { sha: COMMIT },
		added: [{ path: "new.md", kind: "KNOWLEDGE", isText: true }],
		removed: [{ path: "gone.md", kind: "RULE", isText: true }],
		changed: [{ path: "AGENTS.md", kind: "INSTRUCTIONS", isText: true }],
		truncated: false,
		...overrides,
	};
}

function dialog(props: Record<string, unknown> = {}) {
	return (
		<InstructionsCompareDialog
			projectId="p"
			commits={{ from: PARENT, to: COMMIT }}
			open
			onOpenChange={() => undefined}
			{...props}
		/>
	);
}

function setFile(sha: string, path: string, answer: Record<string, unknown>) {
	state.files.set(`${sha}:${path}`, answer);
}

beforeEach(() => {
	state.comparison = comparison();
	state.compareError = null;
	state.compareCalls = [];
	state.files = new Map();
	state.readCalls = [];
	state.snapshotCalls = [];
});

describe("InstructionsCompareDialog — two commits", () => {
	it("compares the two commits and names them, never touching a version", async () => {
		render(dialog(), { wrapper: Wrapper });

		expect(await screen.findByText("Compare commits")).toBeInTheDocument();
		expect(state.compareCalls).toEqual([
			{ projectId: "p", from: PARENT, to: COMMIT },
		]);
		expect(
			await screen.findByText(
				"What changed from commit 9a8b7c6 to commit a1b2c3d",
			),
		).toBeInTheDocument();
		expect(state.snapshotCalls).toEqual([]);
	});

	it("summarises what changed, with no count of unchanged files, which a commit comparison does not have", async () => {
		render(dialog(), { wrapper: Wrapper });

		expect(
			await screen.findByText("1 added, 1 removed, 1 changed"),
		).toBeInTheDocument();
		expect(screen.queryByText(/unchanged/)).toBeNull();
		expect(screen.getByText("new.md")).toBeInTheDocument();
		expect(screen.getByText("gone.md")).toBeInTheDocument();
		expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
	});

	it("reads no file until a changed row is expanded, and never for an added or removed one", async () => {
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });
		await screen.findByText("AGENTS.md");
		expect(state.readCalls).toEqual([]);

		await user.click(screen.getByRole("button", { name: /AGENTS\.md/ }));

		await waitFor(() => expect(state.readCalls).toHaveLength(2));
		expect(state.readCalls).toEqual(
			expect.arrayContaining([
				{ projectId: "p", sha: PARENT, path: "AGENTS.md" },
				{ projectId: "p", sha: COMMIT, path: "AGENTS.md" },
			]),
		);
		expect(state.readCalls.map((call) => call.path)).not.toContain(
			"new.md",
		);
		expect(state.readCalls.map((call) => call.path)).not.toContain(
			"gone.md",
		);
	});

	it("draws the line diff of an expanded file from its two sides", async () => {
		setFile(PARENT, "AGENTS.md", { state: "found", content: "one\ntwo\n" });
		setFile(COMMIT, "AGENTS.md", {
			state: "found",
			content: "one\nthree\n",
		});
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });
		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);

		const diff = await screen.findByTestId(
			"instruction-file-diff-AGENTS.md",
		);

		expect(diff).toHaveTextContent("two");
		expect(diff).toHaveTextContent("three");
		expect(screen.getByText("+1 −1")).toBeInTheDocument();
	});

	it("treats a side where the file does not exist as empty", async () => {
		setFile(COMMIT, "AGENTS.md", { state: "found", content: "all new\n" });
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });
		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);

		const diff = await screen.findByTestId(
			"instruction-file-diff-AGENTS.md",
		);

		expect(diff).toHaveTextContent("all new");
		expect(screen.getByText("+1 −0")).toBeInTheDocument();
	});

	it.each([
		[
			"a commit the scan refused",
			{ state: "withheld", reason: "refused" },
			"Fabric doesn't show this file: the secret scan refused the commit it is in.",
		],
		[
			"a file that holds a secret",
			{ state: "withheld", reason: "secret" },
			"Fabric doesn't show this file: it looks like it contains a secret.",
		],
		[
			"a file that is not text",
			{ state: "binary" },
			"This file is not text, so there is no line diff to show.",
		],
		[
			"a file past the inline cap",
			{ state: "tooLarge" },
			"This file is too large to compare here.",
		],
	])(
		"says so in one plain line, not a diff, for %s",
		async (_label, answer, sentence) => {
			setFile(PARENT, "AGENTS.md", {
				state: "found",
				content: "before\n",
			});
			setFile(COMMIT, "AGENTS.md", answer);
			const user = userEvent.setup();
			render(dialog(), { wrapper: Wrapper });
			await user.click(
				await screen.findByRole("button", { name: /AGENTS\.md/ }),
			);

			expect(await screen.findByText(sentence)).toBeInTheDocument();
			expect(
				screen.queryByTestId("instruction-file-diff-AGENTS.md"),
			).toBeNull();
			// Nothing of the other side's text leaks beside it.
			expect(screen.queryByText(/before/)).toBeNull();
		},
	);

	it("puts what Fabric withholds ahead of a side that is merely large or binary", async () => {
		setFile(PARENT, "AGENTS.md", { state: "tooLarge" });
		setFile(COMMIT, "AGENTS.md", { state: "withheld", reason: "secret" });
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });
		await user.click(
			await screen.findByRole("button", { name: /AGENTS\.md/ }),
		);

		expect(
			await screen.findByText(
				"Fabric doesn't show this file: it looks like it contains a secret.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/too large/)).toBeNull();
	});

	it("reads nothing for a file that is not text, and says so", async () => {
		state.comparison = comparison({
			changed: [{ path: "logo.png", kind: "OTHER", isText: false }],
		});
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });

		await user.click(
			await screen.findByRole("button", { name: /logo\.png/ }),
		);

		expect(
			await screen.findByText(
				"This file is not text, so there is no line diff to show.",
			),
		).toBeInTheDocument();
		expect(state.readCalls).toEqual([]);
	});

	it("holds a script's text back until it is asked for, as a version comparison does", async () => {
		state.comparison = comparison({
			changed: [{ path: "scripts/run.sh", kind: "SCRIPT", isText: true }],
		});
		setFile(PARENT, "scripts/run.sh", { state: "found", content: "a\n" });
		setFile(COMMIT, "scripts/run.sh", { state: "found", content: "b\n" });
		const user = userEvent.setup();
		render(dialog(), { wrapper: Wrapper });
		await user.click(
			await screen.findByRole("button", { name: /scripts\/run\.sh/ }),
		);

		expect(
			await screen.findByRole("button", { name: "Show diff" }),
		).toBeInTheDocument();
		expect(state.readCalls).toEqual([]);

		await user.click(screen.getByRole("button", { name: "Show diff" }));

		expect(
			await screen.findByTestId("instruction-file-diff-scripts/run.sh"),
		).toBeInTheDocument();
		expect(state.readCalls).toHaveLength(2);
	});

	it("says the list stops short when the provider capped it, and does not claim the commits are the same", async () => {
		state.comparison = comparison({
			added: [],
			removed: [],
			changed: [],
			truncated: true,
		});
		render(dialog(), { wrapper: Wrapper });

		expect(
			await screen.findByText(
				"The repository lists only part of the files that changed, so more may have changed than are named here.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				en.projects.codingInstructions.compare.noDifferences,
			),
		).toBeNull();
	});

	it("says the two commits hold the same files when nothing differs and nothing was cut short", async () => {
		state.comparison = comparison({ added: [], removed: [], changed: [] });
		render(dialog(), { wrapper: Wrapper });

		expect(
			await screen.findByText(
				en.projects.codingInstructions.compare.noDifferences,
			),
		).toBeInTheDocument();
	});

	it("says it could not compare, and shows nothing it did not read", async () => {
		state.compareError = new Error("unreachable");
		render(dialog(), { wrapper: Wrapper });

		const alert = await screen.findByRole("alert");
		expect(
			within(alert).getByText(
				"Could not compare these two commits. Close this and try again.",
			),
		).toBeInTheDocument();
	});

	it("reads nothing while closed", async () => {
		render(dialog({ open: false }), { wrapper: Wrapper });

		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(state.compareCalls).toEqual([]);
	});
});
