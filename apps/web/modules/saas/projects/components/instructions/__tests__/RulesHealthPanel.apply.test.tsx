/**
 * Rules health, the AI review and "Apply suggestions" telling one story:
 * the review is rendered from its structured findings under the shared
 * category headings, the panel's counts line and the dialog's are the same,
 * the dialog lists exactly the flagged files (each with its category badges,
 * an edit or "Not changed: <reason>"), a commit shows progress only on the
 * dialog's button, and its result is one line in the panel (sha or pull
 * request, linked). Also: "Apply suggestions" only once a review is shown,
 * disabled with its reason for a member who cannot edit, and Submit sending
 * only the checked files through the editor's own change path. The badge and
 * the budget meter follow one computed state. Copy is the real `en.json`.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const mocks = vi.hoisted(() => ({
	commitChange: vi.fn(),
	editInstructionSnapshot: vi.fn(),
	reviewRules: vi.fn(),
	suggestRuleEdits: vi.fn(),
	toastInfo: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	health: { current: {} as Record<string, unknown> },
	state: { current: {} as Record<string, unknown> },
	settings: {
		current: { sourceOfTruth: "FABRIC" } as Record<string, unknown>,
	},
	sync: { current: { configured: null } as Record<string, unknown> },
	operation: {
		current: { status: "VALIDATING", commitOutcome: null } as Record<
			string,
			unknown
		>,
	},
	commits: { current: { commits: [] } as Record<string, unknown> },
	pullRequest: { current: { pullRequest: null } as Record<string, unknown> },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { instructions: { commitChange: mocks.commitChange } },
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: (...a: unknown[]) =>
		mocks.editInstructionSnapshot(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => mocks.toastInfo(...a),
		success: (...a: unknown[]) => mocks.toastSuccess(...a),
		error: (...a: unknown[]) => mocks.toastError(...a),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const query = (name: string, fn: () => unknown) => ({
		queryOptions: (o: unknown) => ({
			queryKey: [name, o],
			queryFn: async () => fn(),
		}),
	});
	return {
		orpc: {
			projects: {
				instructions: {
					key: () => ["instructions"],
					rulesHealth: query(
						"rulesHealth",
						() => mocks.health.current,
					),
					reviewRules: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) =>
								mocks.reviewRules(input),
						}),
					},
					suggestRuleEdits: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) =>
								mocks.suggestRuleEdits(input),
						}),
					},
					repository: {
						getState: query("getState", () => mocks.state.current),
						listCommits: query(
							"listCommits",
							() => mocks.commits.current,
						),
					},
					getSettings: query(
						"getSettings",
						() => mocks.settings.current,
					),
					repositorySync: {
						get: query("syncGet", () => mocks.sync.current),
						listCommits: query(
							"syncListCommits",
							() => mocks.commits.current,
						),
					},
					get: query("get", () => ({
						status: "VALIDATING",
						commitOutcome: null,
					})),
					getGitOperation: query(
						"getGitOperation",
						() => mocks.operation.current,
					),
					proposals: {
						getPullRequestStatus: query(
							"pr",
							() => mocks.pullRequest.current,
						),
					},
				},
			},
		},
	};
});

import { RulesHealthPanel } from "../RulesHealthPanel";

const HEALTH = {
	source: "published",
	budget: 8000,
	alwaysOnChars: 7400,
	rules: [
		{ path: ".claude/rules/a.md", tier: "always-on", chars: 4000 },
		{ path: ".claude/rules/b.md", tier: "always-on", chars: 3400 },
		{ path: ".claude/rules/c.md", tier: "over-budget", chars: 3000 },
	],
	findings: [
		{
			kind: "over-budget",
			paths: [".claude/rules/c.md"],
			detail: "The always-on rules are past the budget.",
		},
	],
};

/** The review: the checks' over-budget finding, then the model's. */
const FINDINGS = [
	{
		category: "over-budget",
		files: [".claude/rules/c.md"],
		summary: "The always-on rules are past the budget.",
	},
	{
		category: "overlap",
		files: [".claude/rules/a.md", ".claude/rules/b.md"],
		summary:
			"`a.md` and `b.md` repeat each other.\n\n### Merged\nOne rule.",
	},
	{
		category: "vague",
		files: [".claude/rules/b.md"],
		summary: "Say what careful means.",
	},
];

const EDITS = [
	{
		path: ".claude/rules/a.md",
		before: "Write tests.\nAlways write tests.\n",
		after: `Write a test for every change. ${"x".repeat(400)}\n`,
		action: "update",
		reason: "Merge the repeated rule",
		categories: ["overlap"],
	},
	{
		path: ".claude/rules/b.md",
		before: "Be careful.\n",
		after: "",
		action: "delete",
		reason: "Too vague to act on",
		categories: ["overlap", "vague"],
	},
];

const SKIPPED = [
	{
		path: ".claude/rules/c.md",
		categories: ["over-budget"],
		why: "not-changed",
	},
];

function renderPanel(
	props: { canEdit?: boolean; readOnlyMode?: boolean } = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<RulesHealthPanel projectId="proj_1" {...props} />
		</QueryClientProvider>,
	);
}

async function showReview(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		await screen.findByRole("button", { name: /rules health/i }),
	);
	await user.click(screen.getByRole("button", { name: "Review with AI" }));
	await screen.findByRole("heading", { name: "Overlap" });
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
	await user.click(
		screen.getByRole("button", { name: /apply suggestions/i }),
	);
	const dialog = await screen.findByRole("dialog");
	await within(dialog).findByText("Merge the repeated rule");
	return dialog;
}

function useDirectRepository() {
	mocks.state.current = {
		availability: "READY",
		ref: "main",
		generation: 3,
		currentCommitSha: SHA,
	};
	mocks.suggestRuleEdits.mockResolvedValue({
		base: { nativeBase: { generation: 3, commitSha: SHA } },
		edits: EDITS,
		skipped: SKIPPED,
	});
}

beforeEach(() => {
	for (const fn of [
		mocks.commitChange,
		mocks.editInstructionSnapshot,
		mocks.reviewRules,
		mocks.suggestRuleEdits,
		mocks.toastInfo,
		mocks.toastSuccess,
		mocks.toastError,
	]) {
		fn.mockReset();
	}
	mocks.health.current = HEALTH;
	mocks.reviewRules.mockResolvedValue({ findings: FINDINGS });
	mocks.suggestRuleEdits.mockResolvedValue({
		base: { baseSnapshotId: "snap_pub" },
		edits: EDITS,
		skipped: SKIPPED,
	});
	mocks.state.current = { availability: "UPLOAD" };
	mocks.settings.current = { sourceOfTruth: "FABRIC" };
	mocks.sync.current = { configured: null };
	mocks.operation.current = { status: "VALIDATING", commitOutcome: null };
	mocks.commits.current = { commits: [] };
	mocks.pullRequest.current = { pullRequest: null };
	mocks.commitChange.mockResolvedValue({
		kind: "native",
		operationId: "op_1",
		nativeBase: { generation: 3, commitSha: SHA },
		putCount: 1,
		deleteCount: 0,
		status: "VALIDATING",
	});
	mocks.editInstructionSnapshot.mockResolvedValue({
		snapshotId: "snap_new",
		version: 9,
	});
});

describe("RulesHealthPanel: the review", () => {
	it("renders the findings under the shared headings at the panel's text size, and Apply only after it", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });

		await user.click(
			await screen.findByRole("button", { name: /rules health/i }),
		);
		expect(
			screen.queryByRole("button", { name: /apply suggestions/i }),
		).toBeNull();

		await user.click(
			screen.getByRole("button", { name: "Review with AI" }),
		);
		const heading = await screen.findByRole("heading", { name: "Overlap" });
		expect(heading.className).toContain("text-sm");
		expect(
			screen.getByRole("heading", { name: "Over the always-on budget" }),
		).toBeTruthy();
		expect(
			screen.getByRole("heading", { name: "Vague rules" }),
		).toBeTruthy();
		const merged = screen.getByRole("heading", { name: "Merged" });
		expect(merged.closest(".prose")?.className).toContain(
			"prose-headings:text-sm",
		);
		expect(
			screen.getByRole("button", { name: /apply suggestions/i }),
		).toBeTruthy();
	});

	it("shows one counts line, in files per category", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);

		expect(screen.getByTestId("rule-review-summary").textContent).toBe(
			"Review: 3 suggestions in 3 files (1 over budget, 2 overlap, 1 vague)",
		);
	});
});

describe("RulesHealthPanel: Apply suggestions", () => {
	it("is disabled with the reason for a member who cannot edit, and asks for nothing", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: false });
		await showReview(user);

		const button = screen.getByRole("button", {
			name: /apply suggestions/i,
		});
		expect(button.getAttribute("aria-disabled")).toBe("true");
		await user.click(button);

		expect(mocks.suggestRuleEdits).not.toHaveBeenCalled();
		expect(mocks.toastInfo).toHaveBeenCalledWith(
			"Only members who can edit the instructions can apply suggestions.",
		);
	});

	it("sends the review's findings and lists exactly the flagged files, with badges, reasons, diffs and the same counts", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const panelLine =
			screen.getByTestId("rule-review-summary").textContent ?? "";

		const dialog = await openDialog(user);

		expect(mocks.suggestRuleEdits).toHaveBeenCalledWith({
			projectId: "proj_1",
			findings: FINDINGS,
		});
		expect(
			within(dialog).getByTestId("rule-review-summary").textContent,
		).toBe(panelLine);
		expect(
			within(dialog).getByText("2 edits · 1 not changed"),
		).toBeTruthy();

		const list = within(dialog).getByRole("list", {
			name: "Suggested edits",
		});
		const items = within(list).getAllByRole("listitem");
		expect(
			items.map((item) => item.querySelector("code")?.textContent),
		).toEqual([
			".claude/rules/c.md",
			".claude/rules/a.md",
			".claude/rules/b.md",
		]);

		const boxes = within(dialog).getAllByRole("checkbox");
		expect(boxes).toHaveLength(2);
		for (const box of boxes) {
			expect(box.getAttribute("aria-checked")).toBe("true");
		}
		expect(within(dialog).getByText("Too vague to act on")).toBeTruthy();
		expect(
			within(items[2] as HTMLElement)
				.getAllByTestId(/^rule-category-/)
				.map((badge) => badge.textContent),
		).toEqual(["overlap", "vague"]);
		expect(
			within(dialog).getByTestId(
				"instruction-file-diff-.claude/rules/a.md",
			).textContent,
		).toContain("Write a test for every change.");
	});

	it("lists a flagged file the model did not change under Not changed, with its category", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		const row = within(dialog).getByTestId("rule-edit-not-changed");
		expect(row.textContent).toContain(".claude/rules/c.md");
		expect(row.textContent).toContain(
			"Not changed: no edit was suggested for it",
		);
		expect(
			within(row).getByTestId("rule-category-over-budget").textContent,
		).toBe("over budget");
		expect(within(row).queryByRole("checkbox")).toBeNull();
	});

	it("wraps long diff lines in the dialog instead of scrolling sideways", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		const diff = within(dialog).getByTestId(
			"instruction-file-diff-.claude/rules/a.md",
		);
		expect(diff.className).toContain("whitespace-pre-wrap");
		expect(diff.className).toContain("overflow-x-hidden");
		expect(diff.className).not.toMatch(/(^|\s)overflow-auto(\s|$)/);
	});

	it("submits only the checked files as a new version on a Fabric project", async () => {
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		await user.click(
			within(dialog).getAllByRole("checkbox")[1] as HTMLElement,
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Save & publish" }),
		);

		await waitFor(() =>
			expect(mocks.editInstructionSnapshot).toHaveBeenCalledOnce(),
		);
		const input = mocks.editInstructionSnapshot.mock.calls[0]?.[0] as {
			baseSnapshotId: string;
			publishOnReady: boolean;
			proposal: boolean;
			edits: Array<{ op: string; path: string; body?: Blob }>;
		};
		expect(input.baseSnapshotId).toBe("snap_pub");
		expect(input.publishOnReady).toBe(true);
		expect(input.proposal).toBe(false);
		expect(input.edits.map((e) => [e.op, e.path])).toEqual([
			["put", ".claude/rules/a.md"],
		]);
		expect(await input.edits[0]?.body?.text()).toBe(EDITS[0]?.after);
		expect(mocks.commitChange).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"Saved. Checking the new version.",
			),
		);
	});

	it("commits only the checked files to the branch of a repository read directly", async () => {
		useDirectRepository();
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		await user.click(
			within(dialog).getAllByRole("checkbox")[0] as HTMLElement,
		);
		await user.click(
			await within(dialog).findByRole("button", {
				name: "Commit to main",
			}),
		);

		await waitFor(() => expect(mocks.commitChange).toHaveBeenCalledOnce());
		expect(mocks.commitChange).toHaveBeenCalledWith({
			projectId: "proj_1",
			nativeBase: { generation: 3, commitSha: SHA },
			message: "Apply 2 rules review suggestions",
			changes: [{ op: "delete", path: ".claude/rules/b.md" }],
		});
		expect(mocks.editInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("shows a running commit only on the dialog's button, not in the panel", async () => {
		useDirectRepository();
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		const submit = within(dialog).getByRole("button", {
			name: "Commit to main",
		});
		await user.click(submit);
		await waitFor(() => expect(mocks.commitChange).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(submit.getAttribute("aria-busy")).toBe("true"),
		);

		// One indicator: the button's spinner. No "Committing to main…" pill
		// or other status anywhere on the page.
		expect(screen.queryByText(/committing to/i)).toBeNull();
		expect(
			document.querySelectorAll(".animate-spin, [class*='animate-spin']"),
		).toHaveLength(1);
		expect(submit.querySelector("[class*='animate-spin']")).not.toBeNull();
		expect(screen.queryByTestId("rule-suggestions-result")).toBeNull();
		expect(screen.getByRole("dialog")).toBeTruthy();
	});

	it("closes the dialog when the commit lands and shows the result line with the linked sha", async () => {
		useDirectRepository();
		mocks.commits.current = {
			commits: [
				{
					sha: NEW_SHA,
					url: `https://git.example.com/example-org/rules/commit/${NEW_SHA}`,
				},
			],
		};
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		mocks.operation.current = {
			status: "READY",
			commitOutcome: { outcome: "committed", sha: NEW_SHA, ref: "main" },
		};
		mocks.state.current = {
			...mocks.state.current,
			currentCommitSha: NEW_SHA,
		};
		await user.click(
			within(dialog).getByRole("button", { name: "Commit to main" }),
		);

		const line = await screen.findByTestId(
			"rule-suggestions-result",
			{},
			{ timeout: 5_000 },
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(line.textContent).toContain("Committed 2 files");
		const link = await within(line).findByRole("link", {
			name: /bbbbbbb/,
		});
		expect(link.getAttribute("href")).toBe(
			`https://git.example.com/example-org/rules/commit/${NEW_SHA}`,
		);
		expect(mocks.toastSuccess).not.toHaveBeenCalled();
	});

	it("shows the pull request a protected branch opened as the result line", async () => {
		useDirectRepository();
		mocks.pullRequest.current = {
			pullRequest: {
				url: "https://git.example.com/example-org/rules/pull/12",
				externalId: "12",
			},
		};
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		mocks.operation.current = {
			status: "READY",
			commitOutcome: {
				outcome: "pull-request",
				operationId: "op_pr",
				reason: "protected",
			},
		};
		await user.click(
			within(dialog).getByRole("button", { name: "Commit to main" }),
		);

		const line = await screen.findByTestId(
			"rule-suggestions-result",
			{},
			{ timeout: 5_000 },
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		const link = await within(line).findByRole("link", {
			name: /Pull request #12/,
		});
		expect(link.getAttribute("href")).toBe(
			"https://git.example.com/example-org/rules/pull/12",
		);
		// The panel's line replaces the inline pull-request notice.
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps a failed commit's error in the open dialog", async () => {
		useDirectRepository();
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		const dialog = await openDialog(user);

		mocks.operation.current = {
			status: "READY",
			commitOutcome: {
				outcome: "failed",
				code: "UNKNOWN",
				retryable: true,
			},
		};
		await user.click(
			within(dialog).getByRole("button", { name: "Commit to main" }),
		);

		expect(
			(await within(dialog).findByRole("alert", {}, { timeout: 5_000 }))
				.textContent,
		).not.toBe("");
		expect(mocks.toastError).not.toHaveBeenCalled();
		expect(screen.queryByTestId("rule-suggestions-result")).toBeNull();
	});

	it("suggests a pull request instead of committing in Read-only mode", async () => {
		useDirectRepository();
		const user = userEvent.setup();
		renderPanel({ canEdit: true, readOnlyMode: true });
		await showReview(user);
		const dialog = await openDialog(user);

		await user.click(
			within(dialog).getByRole("button", { name: "Submit suggestion" }),
		);

		await waitFor(() =>
			expect(mocks.editInstructionSnapshot).toHaveBeenCalledOnce(),
		);
		expect(mocks.editInstructionSnapshot.mock.calls[0]?.[0]).toMatchObject({
			nativeBase: { generation: 3, commitSha: SHA },
			proposal: true,
			publishOnReady: false,
		});
		expect(mocks.commitChange).not.toHaveBeenCalled();
	});

	it("says, through the shared action-error wording, that the edits could not be prepared", async () => {
		mocks.suggestRuleEdits.mockRejectedValue(
			new Error("The AI suggestions are unavailable."),
		);
		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		await showReview(user);
		await user.click(
			screen.getByRole("button", { name: /apply suggestions/i }),
		);

		const dialog = await screen.findByRole("dialog");
		// Errors go through useInstructionActionError, never raw text.
		expect((await within(dialog).findByRole("alert")).textContent).toBe(
			"That didn't work. Try again.",
		);
		expect(
			within(dialog)
				.getByRole("button", { name: "Save & publish" })
				.hasAttribute("disabled"),
		).toBe(true);
	});
});

describe("RulesHealthPanel: badge and budget", () => {
	async function bar(health: Record<string, unknown>) {
		mocks.health.current = { ...HEALTH, ...health };
		renderPanel();
		return (await screen.findByTestId("rules-budget-bar")) as HTMLElement;
	}

	it("keeps the meter neutral while there is headroom and nothing is over budget", async () => {
		const meter = await bar({
			alwaysOnChars: 6150,
			rules: [
				{ path: ".claude/rules/a.md", tier: "always-on", chars: 6150 },
			],
			findings: [],
		});

		expect(meter.dataset.state).toBe("headroom");
		expect(meter.className).not.toMatch(/bg-(destructive|amber|primary)/);
		expect(screen.getByTestId("rules-health-badge").textContent).toBe(
			"clean",
		);
	});

	it("turns the meter amber when rules are over budget, or within a tenth of it", async () => {
		const meter = await bar({});
		expect(meter.dataset.state).toBe("close");
		expect(meter.className).toContain("bg-amber-500");
		expect(meter.className).not.toContain("bg-destructive");
	});

	it("turns the meter amber near the budget with nothing over it", async () => {
		const meter = await bar({
			alwaysOnChars: 7300,
			rules: [
				{ path: ".claude/rules/a.md", tier: "always-on", chars: 7300 },
			],
			findings: [],
		});
		expect(meter.dataset.state).toBe("close");
		expect(meter.className).toContain("bg-amber-500");
	});

	it("turns the meter destructive only when the always-on rules exceed the budget", async () => {
		const meter = await bar({ alwaysOnChars: 8200 });
		expect(meter.dataset.state).toBe("over");
		expect(meter.className).toContain("bg-destructive");
	});

	it("counts flagged files on the badge and explains it in a tooltip, opening the list of files", async () => {
		const user = userEvent.setup();
		mocks.health.current = {
			...HEALTH,
			findings: [
				...HEALTH.findings,
				{
					kind: "duplicate",
					paths: [".claude/rules/a.md", ".claude/rules/b.md"],
					detail: "The same rule twice: keep one.",
				},
			],
		};
		renderPanel();

		const badge = await screen.findByTestId("rules-health-badge");
		expect(badge.textContent).toBe("3 to clean up");
		await user.hover(badge);
		const tooltip = await screen.findByRole("tooltip");
		expect(tooltip.textContent).toContain(
			"Files the checks flagged: 1 over budget, 2 clean-up",
		);

		await user.click(badge);
		const list = await screen.findByRole("list", {
			name: "What the checks found",
		});
		expect(list.textContent).toContain(".claude/rules/c.md");
		expect(list.textContent).toContain(".claude/rules/b.md");
	});
});
