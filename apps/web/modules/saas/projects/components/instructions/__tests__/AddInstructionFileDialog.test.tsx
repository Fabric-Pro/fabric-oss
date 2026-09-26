/**
 * `AddInstructionFileDialog` — one file added to (or replacing one in) the
 * published version, through the same derive → upload → verify → publish path
 * an edit and a folder upload both take.
 *
 * What this suite pins is the part a server test cannot see: the destination
 * path the dialog PROPOSES, and the refusals it shows before a file is read
 * and a version is registered. The refusals are all re-checked by `derive`,
 * which is the authority; checking them here is what keeps a mistyped path
 * from costing a round trip and a RECEIVING row.
 *
 * Copy is resolved from the real `en.json` (the shared `next-intl` mock only
 * echoes keys), the same technique the sibling suites use.
 */
import en from "@repo/i18n/translations/en.json";
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
	editInstructionSnapshot: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	AddInstructionFileDialog,
	proposedPath,
} from "../AddInstructionFileDialog";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderDialog(
	folder: string | null = null,
	props: Partial<ComponentProps<typeof AddInstructionFileDialog>> = {},
) {
	return render(
		<AddInstructionFileDialog
			projectId="p"
			baseSnapshotId="s7"
			open
			onOpenChange={() => undefined}
			folder={folder}
			onAdded={() => undefined}
			{...props}
		/>,
		{ wrapper: TestQueryProvider },
	);
}

function pick(name: string, contents = "# hello") {
	return new File([contents], name, { type: "text/markdown" });
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.editInstructionSnapshot.mockResolvedValue({
		snapshotId: "snap_new",
		version: 8,
	});
});

describe("proposedPath", () => {
	it("puts a file at the root when no folder is selected", () => {
		expect(proposedPath("CLAUDE.md", null)).toBe("CLAUDE.md");
	});

	it("puts a file inside the selected folder", () => {
		expect(proposedPath("SKILL.md", ".claude/skills/review")).toBe(
			".claude/skills/review/SKILL.md",
		);
	});

	it("does not double the separator for a folder with a trailing slash", () => {
		expect(proposedPath("SKILL.md", ".claude/skills/review/")).toBe(
			".claude/skills/review/SKILL.md",
		);
	});
});

describe("AddInstructionFileDialog", () => {
	it("submits a reader's file as a proposal without offering direct publication", async () => {
		const user = userEvent.setup();
		renderDialog(null, { proposalOnly: true, canPropose: true });

		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		expect(
			screen.queryByLabelText(
				"Publish as soon as the new version passes checks",
			),
		).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "Submit proposal" }),
		);

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					publishOnReady: false,
				}),
			),
		);
	});

	it("proposes the picked file's name inside the selected folder and sends it as a put", async () => {
		const user = userEvent.setup();
		renderDialog(".claude/skills/review");

		await user.upload(
			screen.getByLabelText("File"),
			pick("SKILL.md", "# Review"),
		);
		expect(screen.getByLabelText("Where it goes")).toHaveValue(
			".claude/skills/review/SKILL.md",
		);

		await user.click(screen.getByRole("button", { name: "Add file" }));

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "p",
					baseSnapshotId: "s7",
					publishOnReady: true,
					edits: [
						expect.objectContaining({
							op: "put",
							path: ".claude/skills/review/SKILL.md",
						}),
					],
				}),
			),
		);
	});

	it("keeps a destination the person already typed when the file is swapped", async () => {
		const user = userEvent.setup();
		renderDialog(null);

		const pathField = screen.getByLabelText("Where it goes");
		await user.type(pathField, "docs/GUIDE.md");
		await user.upload(screen.getByLabelText("File"), pick("other.md"));

		expect(pathField).toHaveValue("docs/GUIDE.md");
	});

	it("refuses a credential-shaped filename before anything is sent", async () => {
		const user = userEvent.setup();
		renderDialog(null);

		await user.upload(screen.getByLabelText("File"), pick("secrets.pem"));

		expect(
			screen.getByText(/never stores credential files/),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add file" })).toBeDisabled();
		expect(m.editInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a traversal path", async () => {
		const user = userEvent.setup();
		renderDialog(null);

		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		const pathField = screen.getByLabelText("Where it goes");
		await user.clear(pathField);
		await user.type(pathField, "../escape.md");

		expect(screen.getByText(/cannot be used/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add file" })).toBeDisabled();
	});

	it("refuses .fabricignore, which decides what the version leaves out", async () => {
		const user = userEvent.setup();
		renderDialog(null);

		await user.upload(
			screen.getByLabelText("File"),
			pick(".fabricignore", "tasks/\n"),
		);

		expect(
			screen.getByText(
				"The .fabricignore file can only be changed by uploading the folder again.",
			),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add file" })).toBeDisabled();
	});

	it("can add without publishing", async () => {
		const user = userEvent.setup();
		renderDialog(null);

		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.click(
			screen.getByLabelText(
				"Publish as soon as the new version passes checks",
			),
		);
		await user.click(screen.getByRole("button", { name: "Add file" }));

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({ publishOnReady: false }),
			),
		);
	});
});

// ---------------------------------------------------------------------------
// A suggestion on a repository-backed project (Fizzy #2563 spec §12)
// ---------------------------------------------------------------------------

const addCopy = en.projects.codingInstructions.addFileDialog;
const REPOSITORY_TARGET = {
	repository: "example-org/example-repo",
	ref: "main",
};

function renderSuggestion(
	props: Partial<ComponentProps<typeof AddInstructionFileDialog>> = {},
) {
	return renderDialog(null, {
		proposalOnly: true,
		canPropose: true,
		repositoryTarget: REPOSITORY_TARGET,
		...props,
	});
}

describe("AddInstructionFileDialog — suggesting a change as a pull request", () => {
	it("says where the pull request opens, how the branch is pushed and whom the commit names", () => {
		renderSuggestion();
		expect(
			screen.getByRole("heading", { name: addCopy.repositoryTitle }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This opens a pull request in example-org/example-repo against main. The branch is pushed with the repository connection's credentials, and pushing it can start the repository's CI before anyone reviews it. The commit names you as author with a Fabric no-reply address.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: addCopy.submitPullRequestButton,
			}),
		).toBeInTheDocument();
	});

	it("sends the title and description with the suggestion", async () => {
		const user = userEvent.setup();
		renderSuggestion();
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.type(
			screen.getByLabelText(addCopy.noteTitleLabel),
			"Tighten the lint rule",
		);
		await user.type(
			screen.getByLabelText(addCopy.noteBodyLabel),
			"Why it matters.",
		);
		await user.click(
			screen.getByRole("button", {
				name: addCopy.submitPullRequestButton,
			}),
		);
		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					note: {
						title: "Tighten the lint rule",
						body: "Why it matters.",
					},
				}),
			),
		);
		expect(m.toastSuccess).toHaveBeenCalledWith(
			addCopy.pullRequestSubmitted,
		);
	});

	it("sends no note when both fields are left empty", async () => {
		const user = userEvent.setup();
		renderSuggestion();
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.click(
			screen.getByRole("button", {
				name: addCopy.submitPullRequestButton,
			}),
		);
		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalled(),
		);
		expect(m.editInstructionSnapshot.mock.calls[0]?.[0]).not.toHaveProperty(
			"note",
		);
	});

	it("refuses a title longer than 120 characters before anything is sent", async () => {
		const user = userEvent.setup();
		renderSuggestion();
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.type(
			screen.getByLabelText(addCopy.noteTitleLabel),
			"x".repeat(121),
		);
		expect(screen.getByText(addCopy.noteTitleInvalid)).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: addCopy.submitPullRequestButton,
			}),
		).toBeDisabled();
	});

	it("shows a note the server refused under the field it names", async () => {
		const user = userEvent.setup();
		m.editInstructionSnapshot.mockRejectedValue(
			Object.assign(
				new Error(
					"The note's description looks like it contains a credential. Remove it and try again.",
				),
				{ data: { reason: "NOTE_REJECTED", field: "body" } },
			),
		);
		renderSuggestion();
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.type(
			screen.getByLabelText(addCopy.noteBodyLabel),
			"a pasted secret",
		);
		await user.click(
			screen.getByRole("button", {
				name: addCopy.submitPullRequestButton,
			}),
		);
		const description = screen.getByLabelText(addCopy.noteBodyLabel);
		await waitFor(() =>
			expect(description).toHaveAccessibleDescription(
				expect.stringContaining("looks like it contains a credential"),
			),
		);
		expect(description).toHaveAttribute("aria-invalid", "true");
		expect(m.toastError).not.toHaveBeenCalled();
	});

	it.each([
		"REPOSITORY_UNAVAILABLE",
		"REPOSITORY_BASE_UNAVAILABLE",
		"REPOSITORY_SOURCE_OF_TRUTH",
	] as const)(
		"names the admission refusal %s with its copy",
		async (reason) => {
			const user = userEvent.setup();
			m.editInstructionSnapshot.mockRejectedValue(
				Object.assign(new Error("Refused."), { data: { reason } }),
			);
			renderSuggestion();
			await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
			await user.click(
				screen.getByRole("button", {
					name: addCopy.submitPullRequestButton,
				}),
			);
			await waitFor(() =>
				expect(m.toastError).toHaveBeenCalledWith(
					addCopy.refusals[reason],
				),
			);
		},
	);

	it("keeps an upload-backed editor's direct add free of the note", async () => {
		const user = userEvent.setup();
		renderDialog(null, { canPropose: true });
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.type(
			screen.getByLabelText(addCopy.noteTitleLabel),
			"Only for a proposal",
		);
		await user.click(screen.getByRole("button", { name: "Add file" }));
		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalled(),
		);
		const call = m.editInstructionSnapshot.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(call.proposal).toBe(false);
		expect(call).not.toHaveProperty("note");
	});

	it("sends an upload-backed proposal's note too", async () => {
		const user = userEvent.setup();
		renderDialog(null, { proposalOnly: true, canPropose: true });
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.type(
			screen.getByLabelText(addCopy.noteTitleLabel),
			"Add the review skill",
		);
		await user.click(
			screen.getByRole("button", { name: "Submit proposal" }),
		);
		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					proposal: true,
					note: { title: "Add the review skill" },
				}),
			),
		);
	});
});

// ---------------------------------------------------------------------------
// Publish now and scan afterwards (Fizzy #2737)
// ---------------------------------------------------------------------------

describe("AddInstructionFileDialog — publish now and scan afterwards", () => {
	const copy = en.projects.codingInstructions.publishBeforeScan;

	it("is not offered without the publish permission", () => {
		renderDialog(null);

		expect(
			screen.queryByRole("checkbox", { name: copy.label }),
		).not.toBeInTheDocument();
	});

	it("is never offered in reader (proposal-only) mode", () => {
		renderDialog(null, {
			proposalOnly: true,
			canPropose: true,
			canPublishBeforeScan: true,
		});

		expect(
			screen.queryByRole("checkbox", { name: copy.label }),
		).not.toBeInTheDocument();
	});

	it("blocks the direct add until the risk is acknowledged, then sends the flag", async () => {
		const user = userEvent.setup();
		renderDialog(null, { canPublishBeforeScan: true });
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		const add = screen.getByRole("button", { name: "Add file" });

		await user.click(screen.getByRole("checkbox", { name: copy.label }));

		expect(screen.getByRole("alert")).toHaveTextContent(copy.warningBody);
		expect(add).toBeDisabled();

		await user.click(
			screen.getByRole("checkbox", { name: copy.acknowledge }),
		);
		expect(add).toBeEnabled();
		await user.click(add);

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					publishOnReady: true,
					proposal: false,
					publishBeforeScan: true,
				}),
			),
		);
	});

	it("never sends the flag with a proposal, even when it is ticked", async () => {
		const user = userEvent.setup();
		renderDialog(null, { canPropose: true, canPublishBeforeScan: true });
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));
		await user.click(screen.getByRole("checkbox", { name: copy.label }));

		await user.click(
			screen.getByRole("button", {
				name: en.projects.codingInstructions.addFileDialog
					.submitProposalButton,
			}),
		);

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalled(),
		);
		const [call] = m.editInstructionSnapshot.mock.calls[0]! as [
			Record<string, unknown>,
		];
		expect(call.proposal).toBe(true);
		expect(call).not.toHaveProperty("publishBeforeScan");
	});

	it("sends nothing extra for an ordinary direct add", async () => {
		const user = userEvent.setup();
		renderDialog(null, { canPublishBeforeScan: true });
		await user.upload(screen.getByLabelText("File"), pick("CLAUDE.md"));

		await user.click(screen.getByRole("button", { name: "Add file" }));

		await waitFor(() =>
			expect(m.editInstructionSnapshot).toHaveBeenCalled(),
		);
		const [call] = m.editInstructionSnapshot.mock.calls[0]! as [
			Record<string, unknown>,
		];
		expect(call).not.toHaveProperty("publishBeforeScan");
	});
});
