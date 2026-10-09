/**
 * "Add file" on a repository-backed project commits the file to the synced
 * branch (Fizzy #2878 §10), with a pull request as the alternative; a reader's
 * dialog stays a suggestion. A picked file may be binary, so a commit carries
 * its bytes as base64.
 *
 * Copy is the real `en.json`; the commit's own answer is the mocked
 * `commitChange` plus the row `instructions.get` returns.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
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

const m = vi.hoisted(() => ({
	commitChange: vi.fn(),
	editInstructionSnapshot: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
	snapshotRow: { current: {} as Record<string, unknown> },
	pullRequest: { current: { url: null } as { url: string | null } },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { instructions: { commitChange: m.commitChange } },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				get: {
					queryOptions: (o: unknown) => ({
						queryKey: ["get", o],
						queryFn: async () => m.snapshotRow.current,
					}),
				},
				proposals: {
					getPullRequestStatus: {
						queryOptions: (o: unknown) => ({
							queryKey: ["getPullRequestStatus", o],
							queryFn: async () => ({
								pullRequest: { url: m.pullRequest.current.url },
							}),
						}),
					},
				},
			},
		},
	},
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: (...a: unknown[]) =>
		m.editInstructionSnapshot(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => m.toastSuccess(...a),
		error: (...a: unknown[]) => m.toastError(...a),
		info: (...a: unknown[]) => m.toastInfo(...a),
	},
}));

import { AddInstructionFileDialog } from "../AddInstructionFileDialog";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TARGET = { repository: "example-org/instructions", ref: "main" };

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderDialog(
	props: Partial<ComponentProps<typeof AddInstructionFileDialog>> = {},
) {
	const onOpenChange = vi.fn();
	const onAdded = vi.fn();
	render(
		<AddInstructionFileDialog
			projectId="p"
			baseSnapshotId="s7"
			open
			onOpenChange={onOpenChange}
			folder=".claude/rules"
			canCommit
			canPropose
			repositoryTarget={TARGET}
			onAdded={onAdded}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
	return { onOpenChange, onAdded };
}

async function pickFile(user: ReturnType<typeof userEvent.setup>, file: File) {
	await user.upload(screen.getByLabelText("File"), file);
}

beforeEach(() => {
	for (const fn of [
		m.commitChange,
		m.editInstructionSnapshot,
		m.toastSuccess,
		m.toastError,
		m.toastInfo,
	]) {
		fn.mockReset();
	}
	m.commitChange.mockResolvedValue({
		snapshotId: "snap_commit",
		version: 8,
		baseSnapshotId: "s7",
		fileCount: 5,
		putCount: 1,
		deleteCount: 0,
		status: "RECEIVING",
	});
	m.editInstructionSnapshot.mockResolvedValue({
		snapshotId: "snap_pr",
		version: 8,
	});
	m.snapshotRow.current = {
		status: "READY",
		commitOutcome: { outcome: "committed", sha: SHA, ref: "main" },
	};
	m.pullRequest.current = { url: null };
});

describe("AddInstructionFileDialog — commit to the branch", () => {
	it("names the branch it commits to and offers Commit, a pull request, and Cancel", () => {
		renderDialog();

		expect(screen.getByText("Add a file to main")).toBeInTheDocument();
		expect(
			screen.getByText(
				/commits the file to main in example-org\/instructions/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Commit to main" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Suggest as a pull request" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Cancel" }),
		).toBeInTheDocument();
		// A repository project has no version to publish on a pass.
		expect(
			screen.queryByLabelText(
				/Publish as soon as the new version passes checks/,
			),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Add file" })).toBeNull();
	});

	it("starts the message from the path the file goes to, and follows it until the person writes their own", async () => {
		const user = userEvent.setup();
		renderDialog();
		await pickFile(user, new File(["# rule"], "naming.md"));

		expect(screen.getByLabelText("Commit message")).toHaveValue(
			"Add .claude/rules/naming.md",
		);

		const path = screen.getByLabelText("Where it goes");
		await user.clear(path);
		await user.type(path, "docs/naming.md");
		expect(screen.getByLabelText("Commit message")).toHaveValue(
			"Add docs/naming.md",
		);

		const message = screen.getByLabelText("Commit message");
		await user.clear(message);
		await user.type(message, "Document naming");
		await user.clear(path);
		await user.type(path, "docs/names.md");
		expect(screen.getByLabelText("Commit message")).toHaveValue(
			"Document naming",
		);
	});

	it("commits the file's bytes as base64, so a file that is not text survives", async () => {
		const user = userEvent.setup();
		const { onAdded, onOpenChange } = renderDialog();
		const bytes = new Uint8Array([0, 255, 128, 10, 13, 200]);
		await pickFile(
			user,
			new File([bytes], "logo.png", { type: "image/png" }),
		);

		await user.click(
			screen.getByRole("button", { name: "Commit to main" }),
		);

		await waitFor(() =>
			expect(m.commitChange).toHaveBeenCalledWith({
				projectId: "p",
				baseSnapshotId: "s7",
				message: "Add .claude/rules/logo.png",
				changes: [
					{
						op: "put",
						path: ".claude/rules/logo.png",
						content: btoa(String.fromCharCode(...bytes)),
						encoding: "base64",
					},
				],
			}),
		);
		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				"Committed 0123456 to main",
			),
		);
		expect(onAdded).toHaveBeenCalled();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("refuses a file larger than one commit can carry, with the way on", async () => {
		const user = userEvent.setup();
		renderDialog();
		await pickFile(
			user,
			new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.bin"),
		);

		expect(
			screen.getByText(
				"This file is larger than 2 MB, which is the most one commit from here can carry. Commit it in your repository.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Commit to main" }),
		).toBeDisabled();
	});

	it("keeps the dialog open on the pull request a protected branch turned the file into, and offers its link", async () => {
		m.snapshotRow.current = {
			status: "READY",
			commitOutcome: {
				outcome: "pull-request",
				operationId: "op_1",
				reason: "protected",
			},
		};
		m.pullRequest.current = {
			url: "https://github.com/example-org/instructions/pull/3",
		};
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await pickFile(user, new File(["# rule"], "naming.md"));

		await user.click(
			screen.getByRole("button", { name: "Commit to main" }),
		);

		expect(
			await screen.findByText(
				"main is protected, so your change was opened as a pull request instead",
			),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("link", { name: /Open the pull request/ }),
		).toHaveAttribute(
			"href",
			"https://github.com/example-org/instructions/pull/3",
		);
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("suggests the file as a pull request through the existing path, without committing", async () => {
		const user = userEvent.setup();
		renderDialog();
		await pickFile(user, new File(["# rule"], "naming.md"));

		await user.click(
			screen.getByRole("button", { name: "Suggest as a pull request" }),
		);

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({ proposal: true }),
			),
		);
		expect(m.commitChange).not.toHaveBeenCalled();
	});

	it("sends the commit message the person typed with the suggestion", async () => {
		const user = userEvent.setup();
		renderDialog();
		await pickFile(user, new File(["# rule"], "naming.md"));
		const message = screen.getByLabelText("Commit message");
		await user.clear(message);
		await user.type(message, "Document naming");

		await user.click(
			screen.getByRole("button", { name: "Suggest as a pull request" }),
		);

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					message: "Document naming",
				}),
			),
		);
	});

	it("shows a refused commit message under its field", async () => {
		m.commitChange.mockRejectedValue({
			code: "UNPROCESSABLE_CONTENT",
			data: { reason: "MESSAGE_EMPTY", field: "message" },
			message: "TEXT THAT MUST NOT BE SHOWN",
		});
		const user = userEvent.setup();
		renderDialog();
		await pickFile(user, new File(["# rule"], "naming.md"));

		await user.click(
			screen.getByRole("button", { name: "Commit to main" }),
		);

		expect(
			await screen.findByText(
				"Write a first line for the commit message.",
			),
		).toBeInTheDocument();
		expect(m.toastError).not.toHaveBeenCalled();
	});

	it("stays a suggestion for a reader: no commit message, no commit button", () => {
		renderDialog({
			canCommit: false,
			canPropose: false,
			proposalOnly: true,
		});

		expect(screen.getByText("Suggest a change")).toBeInTheDocument();
		expect(screen.queryByLabelText("Commit message")).toBeNull();
		expect(screen.queryByRole("button", { name: /^Commit to/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "Suggest as a pull request" }),
		).toBeInTheDocument();
	});
});

describe("AddInstructionFileDialog — a long branch name", () => {
	const LONG = {
		repository: "example-org/instructions",
		ref: "acceptance-restoration-20261006-66d59af",
	};

	it("cannot push the dialog's edge out: one shrinkable column, a wrapping footer, wrapping buttons", () => {
		renderDialog({ repositoryTarget: LONG });

		const dialog = screen.getByRole("dialog");
		const commit = screen.getByRole("button", { name: /^Commit to/ });
		const suggest = screen.getByRole("button", {
			name: "Suggest as a pull request",
		});
		expect(dialog.className).toContain("grid-cols-[minmax(0,1fr)]");
		expect(commit.parentElement?.className).toContain("sm:flex-wrap");
		expect(commit.className).toContain("whitespace-normal");
		expect(suggest.className).toContain("whitespace-normal");
		expect(
			screen.getByRole("heading", { name: /acceptance-restoration/ })
				.className,
		).toContain("[overflow-wrap:anywhere]");
	});
});

describe("instruction dialogs — one shrinkable column", () => {
	it("the rename dialog cannot be pushed wider than its box by a long branch name", async () => {
		const { RenameInstructionFileDialog } = await import(
			"../RenameInstructionFileDialog"
		);
		render(
			<RenameInstructionFileDialog
				open
				onOpenChange={() => undefined}
				projectId="p"
				baseSnapshotId="s7"
				path="docs/a.md"
				content="x"
				repositoryTarget={{
					repository: "example-org/instructions",
					ref: "acceptance-restoration-20261006-66d59af",
				}}
				canCommit
				canPropose
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		const dialog = screen.getByRole("dialog");
		const commit = screen.getByRole("button", { name: /^Commit to/ });
		expect(dialog.className).toContain("grid-cols-[minmax(0,1fr)]");
		expect(commit.parentElement?.className).toContain("sm:flex-wrap");
		expect(commit.className).toContain("whitespace-normal");
	});
});
