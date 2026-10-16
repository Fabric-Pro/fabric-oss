/**
 * Living Memory's write-folder settings (ADR-022):
 *  - the list: one row per folder with how it lands, and who turned direct
 *    push on and when; the empty state says what write folders are;
 *  - adding a folder from the shared tree or by typing it, and changing or
 *    removing one;
 *  - direct push is offered only when the list says the caller may turn it on,
 *    and turning it on asks first, naming the risk;
 *  - every refusal the server gives has its own words (and those words exist
 *    in `en.json`);
 *  - a member who cannot configure only reads the list;
 *  - everything works from the keyboard and icon buttons are labelled.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextSyncConfiguration } from "../../lib/context-repository-sync";
import type { WriteTargetsList } from "../../lib/context-write-targets";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const { listMock, createMock, updateMock, deleteMock, treeMock, membersMock } =
	vi.hoisted(() => ({
		listMock: vi.fn(),
		createMock: vi.fn(),
		updateMock: vi.fn(),
		deleteMock: vi.fn(),
		treeMock: vi.fn(),
		membersMock: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation =
		(fn: (input: unknown) => unknown) =>
		(opts: Record<string, unknown> = {}) => ({
			mutationFn: (input: unknown) => fn(input),
			...opts,
		});
	const query =
		(name: string, fn: (input: unknown) => unknown) =>
		(options: { input: unknown; [key: string]: unknown }) => ({
			...options,
			queryKey: [name, options.input],
			queryFn: () => fn(options.input),
		});
	return {
		orpc: {
			projects: {
				members: {
					list: { queryOptions: query("members", membersMock) },
				},
				contexts: {
					repositorySync: {
						listTree: { queryOptions: query("tree", treeMock) },
						writeTargets: {
							list: { queryOptions: query("list", listMock) },
							create: { mutationOptions: mutation(createMock) },
							update: { mutationOptions: mutation(updateMock) },
							delete: { mutationOptions: mutation(deleteMock) },
						},
					},
				},
			},
		},
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("date-fns", () => ({
	formatDistanceToNow: () => "3 minutes",
}));

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`,
}));

import { toast } from "sonner";
import { ContextWriteTargetsDialog } from "../ContextWriteTargetsDialog";

const NS = "projects.contexts.livingMemory.writeFolders";

const SYNC: ContextSyncConfiguration = {
	syncId: "sync_1",
	repositoryIntegrationId: "int_1",
	ref: "main",
	paths: ["docs"],
	excludedPaths: ["docs/private"],
	automatic: false,
	automaticPausedReason: null,
	automaticPausedAt: null,
	nextCheckAt: null,
	failureCount: 0,
	lastAppliedCommitSha: null,
	configuredByName: "Example Member",
	createdAt: "2026-09-23T09:00:00.000Z",
	updatedAt: "2026-09-23T09:00:00.000Z",
	integration: {
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		status: "ACTIVE",
	},
};

function target(
	overrides: Partial<WriteTargetsList["targets"][number]> = {},
): WriteTargetsList["targets"][number] {
	return {
		id: "wt_1",
		folder: "docs/ai",
		mode: "PULL_REQUEST",
		version: 1,
		directPushEnabledById: null,
		directPushEnabledAt: null,
		updatedById: "user_1",
		createdAt: "2026-10-01T09:00:00.000Z",
		updatedAt: "2026-10-01T09:00:00.000Z",
		...overrides,
	};
}

function list(overrides: Partial<WriteTargetsList> = {}): WriteTargetsList {
	return {
		canConfigure: true,
		canEnableDirectPush: true,
		maxTargets: 10,
		targets: [],
		...overrides,
	};
}

function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<ContextWriteTargetsDialog
				projectId="project_1"
				organizationId={null}
				sync={SYNC}
				open
				onOpenChange={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	listMock.mockResolvedValue(list());
	createMock.mockResolvedValue({});
	updateMock.mockResolvedValue({});
	deleteMock.mockResolvedValue({ deleted: true });
	membersMock.mockResolvedValue({
		members: [{ userId: "user_admin", user: { name: "Example Admin" } }],
	});
	treeMock.mockResolvedValue({
		supported: true,
		truncated: false,
		entries: [
			{ path: "docs/ai/spec.md", type: "file" },
			{ path: "docs/guide/intro.md", type: "file" },
			{ path: "docs/private/notes.md", type: "file" },
			{ path: "src/index.ts", type: "file" },
		],
	});
});

async function openForm(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByRole("button", { name: `${NS}.add` }));
}

async function typeFolder(
	user: ReturnType<typeof userEvent.setup>,
	folder: string,
) {
	await user.type(
		await screen.findByLabelText(`${NS}.picker.typedLabel`),
		folder,
	);
	await user.click(
		screen.getByRole("button", { name: `${NS}.picker.typedUse` }),
	);
}

describe("the list", () => {
	it("shows a row per folder with its mode, and who turned on direct push and when", async () => {
		listMock.mockResolvedValue(
			list({
				targets: [
					target(),
					target({
						id: "wt_2",
						folder: "docs/guide",
						mode: "DIRECT_PUSH",
						directPushEnabledById: "user_admin",
						directPushEnabledAt: "2026-10-02T09:00:00.000Z",
					}),
				],
			}),
		);

		mount();

		const rows = await screen.findAllByTestId("write-folder-row");
		expect(rows).toHaveLength(2);
		expect(within(rows[0]).getByText("docs/ai")).toBeInTheDocument();
		expect(
			within(rows[0]).getByText(`${NS}.mode.PULL_REQUEST`),
		).toBeInTheDocument();
		expect(
			within(rows[1]).getByText(`${NS}.mode.DIRECT_PUSH`),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				within(rows[1]).getByText(
					`${NS}.row.directPushBy${JSON.stringify({ name: "Example Admin", time: "3 minutes" })}`,
				),
			).toBeInTheDocument(),
		);
	});

	it("says what write folders are when there are none", async () => {
		mount();

		const empty = await screen.findByTestId("write-folders-empty");

		expect(empty).toHaveTextContent(`${NS}.empty.title`);
		expect(empty).toHaveTextContent(`${NS}.empty.body{"branch":"main"}`);
	});

	it("offers a retry when the list cannot be read", async () => {
		listMock.mockRejectedValueOnce(new Error("down"));
		const user = userEvent.setup();
		mount();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			`${NS}.loadError`,
		);
		await user.click(screen.getByRole("button", { name: `${NS}.retry` }));

		expect(
			await screen.findByTestId("write-folders-empty"),
		).toBeInTheDocument();
	});

	it("is read-only for a member who cannot configure", async () => {
		listMock.mockResolvedValue(
			list({ canConfigure: false, targets: [target()] }),
		);

		mount();

		await screen.findByTestId("write-folder-row");
		expect(
			screen.queryByRole("button", { name: `${NS}.add` }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: `${NS}.row.edit{"folder":"docs/ai"}`,
			}),
		).not.toBeInTheDocument();
		expect(screen.getByText(`${NS}.readOnly`)).toBeInTheDocument();
	});

	it("disables adding at the limit", async () => {
		listMock.mockResolvedValue(
			list({ maxTargets: 1, targets: [target()] }),
		);

		mount();

		expect(
			await screen.findByRole("button", { name: `${NS}.add` }),
		).toBeDisabled();
	});
});

describe("adding a folder", () => {
	it("creates a pull-request folder chosen in the tree, offering only folders the sync selects", async () => {
		const user = userEvent.setup();
		mount();
		await openForm(user);

		expect(
			await screen.findByRole("checkbox", { name: "docs/private" }),
		).toBeDisabled();
		expect(
			screen.queryByRole("checkbox", { name: "src" }),
		).not.toBeInTheDocument();
		await user.click(
			await screen.findByRole("checkbox", { name: "docs/ai" }),
		);
		expect(screen.getByTestId("write-folder-chosen")).toHaveTextContent(
			"docs/ai",
		);
		await user.click(
			screen.getByRole("button", { name: `${NS}.form.add` }),
		);

		await waitFor(() =>
			expect(createMock).toHaveBeenCalledWith({
				projectId: "project_1",
				folder: "docs/ai",
				mode: "PULL_REQUEST",
			}),
		);
		await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
		expect(
			await screen.findByRole("button", { name: `${NS}.add` }),
		).toBeInTheDocument();
	});

	it("creates a folder that was typed", async () => {
		const user = userEvent.setup();
		mount();
		await openForm(user);

		await typeFolder(user, "docs/notes");
		await user.click(
			screen.getByRole("button", { name: `${NS}.form.add` }),
		);

		await waitFor(() =>
			expect(createMock).toHaveBeenCalledWith({
				projectId: "project_1",
				folder: "docs/notes",
				mode: "PULL_REQUEST",
			}),
		);
	});

	it.each([
		[
			"a folder outside the selection",
			"src/app",
			"TARGET_OUTSIDE_SELECTION",
		],
		["a folder that is left out", "docs/private/x", "TARGET_EXCLUDED"],
		["a folder starting with a dot", "docs/.github", "TARGET_RESERVED"],
		["a folder spelled with a trailing slash", "docs/ai/", "INVALID_PATH"],
	])("refuses %s before asking the server", async (_name, folder, code) => {
		const user = userEvent.setup();
		mount();
		await openForm(user);

		await typeFolder(user, folder);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			`${NS}.errors.${code}`,
		);
		expect(createMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a repository that cannot be browsed",
			() =>
				treeMock.mockResolvedValue({
					supported: false,
					truncated: false,
					entries: [],
				}),
			"tree.writeFolder.unsupported",
		],
		[
			"a listing that failed",
			() => treeMock.mockRejectedValue(new Error("down")),
			"tree.writeFolder.error",
		],
		[
			"a truncated listing",
			() =>
				treeMock.mockResolvedValue({
					supported: true,
					truncated: true,
					entries: [{ path: "docs/ai/spec.md", type: "file" }],
				}),
			'tree.writeFolder.truncated{"max":20000}',
		],
	])(
		"points at the typed folder, not at paths to sync, for %s",
		async (_name, arrange, key) => {
			arrange();
			const user = userEvent.setup();
			mount();
			await openForm(user);

			expect(
				await screen.findByText(
					`projects.contexts.livingMemory.repositorySync.${key}`,
				),
			).toBeInTheDocument();
			const en = JSON.parse(
				readFileSync(
					path.resolve(
						__dirname,
						"../../../../../../../packages/i18n/translations/en.json",
					),
					"utf8",
				),
			).projects.contexts.livingMemory.repositorySync.tree.writeFolder;
			for (const copy of [en.unsupported, en.truncated, en.error]) {
				expect(copy).toContain("Type the folder");
				expect(copy).not.toMatch(/paths to sync/);
			}
		},
	);

	it("keeps Add disabled until a folder is chosen", async () => {
		const user = userEvent.setup();
		mount();
		await openForm(user);

		expect(
			await screen.findByRole("button", { name: `${NS}.form.add` }),
		).toBeDisabled();
	});
});

describe("direct push", () => {
	it("is not offered to someone who cannot turn it on, and says why", async () => {
		listMock.mockResolvedValue(list({ canEnableDirectPush: false }));
		const user = userEvent.setup();
		mount();
		await openForm(user);

		const radio = await screen.findByRole("radio", {
			name: new RegExp(`${NS}.mode.DIRECT_PUSH`),
		});

		expect(radio).toBeDisabled();
		expect(radio).toHaveAccessibleDescription(
			`${NS}.form.directPushNeedsAdmin`,
		);
		expect(
			screen.getByRole("radio", {
				name: new RegExp(`${NS}.mode.PULL_REQUEST`),
			}),
		).toBeChecked();
	});

	it("asks first, naming the branch and the risk, and sends nothing until confirmed", async () => {
		const user = userEvent.setup();
		mount();
		await openForm(user);
		await typeFolder(user, "docs/notes");
		await user.click(
			await screen.findByRole("radio", {
				name: new RegExp(`${NS}.mode.DIRECT_PUSH`),
			}),
		);

		await user.click(
			screen.getByRole("button", { name: `${NS}.form.add` }),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			`${NS}.directPushConfirm.title{"folder":"docs/notes"}`,
		);
		expect(dialog).toHaveTextContent(
			`${NS}.directPushConfirm.description{"branch":"main"}`,
		);
		expect(createMock).not.toHaveBeenCalled();

		await user.click(
			within(dialog).getByRole("button", {
				name: `${NS}.directPushConfirm.confirm`,
			}),
		);

		await waitFor(() =>
			expect(createMock).toHaveBeenCalledWith({
				projectId: "project_1",
				folder: "docs/notes",
				mode: "DIRECT_PUSH",
			}),
		);
	});

	it("sends nothing when the confirmation is declined", async () => {
		const user = userEvent.setup();
		mount();
		await openForm(user);
		await typeFolder(user, "docs/notes");
		await user.click(
			await screen.findByRole("radio", {
				name: new RegExp(`${NS}.mode.DIRECT_PUSH`),
			}),
		);
		await user.click(
			screen.getByRole("button", { name: `${NS}.form.add` }),
		);

		const dialog = await screen.findByRole("alertdialog");
		await user.click(
			within(dialog).getByRole("button", {
				name: `${NS}.directPushConfirm.cancel`,
			}),
		);

		expect(createMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("does not ask when a folder is switched back to a pull request", async () => {
		listMock.mockResolvedValue(
			list({
				targets: [
					target({
						mode: "DIRECT_PUSH",
						directPushEnabledById: "user_admin",
						directPushEnabledAt: "2026-10-02T09:00:00.000Z",
					}),
				],
			}),
		);
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", {
				name: `${NS}.row.edit{"folder":"docs/ai"}`,
			}),
		);

		await user.click(
			await screen.findByRole("radio", {
				name: new RegExp(`${NS}.mode.PULL_REQUEST`),
			}),
		);
		await user.click(
			screen.getByRole("button", { name: `${NS}.form.save` }),
		);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith({
				projectId: "project_1",
				targetId: "wt_1",
				mode: "PULL_REQUEST",
			}),
		);
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});
});

describe("refusals", () => {
	const CODES = [
		"TARGET_RESERVED",
		"TARGET_OUTSIDE_SELECTION",
		"TARGET_EXCLUDED",
		"TARGET_OVERLAP",
		"TARGET_OVERLAPS_INSTRUCTIONS",
		"TOO_MANY_TARGETS",
		"DIRECT_PUSH_REQUIRES_ADMIN",
		"NOT_CONFIGURED",
	];

	it.each(CODES)(
		"shows the words for %s and keeps the form",
		async (code) => {
			createMock.mockRejectedValue(
				Object.assign(new Error("refused"), {
					data: { code, path: "docs/notes", withPath: "docs/ai" },
				}),
			);
			const user = userEvent.setup();
			mount();
			await openForm(user);
			await typeFolder(user, "docs/notes");

			await user.click(
				screen.getByRole("button", { name: `${NS}.form.add` }),
			);

			const alert = await screen.findByTestId("write-folder-error");
			expect(alert).toHaveTextContent(`${NS}.errors.${code}`);
			expect(screen.getByTestId("write-folder-chosen")).toHaveTextContent(
				"docs/notes",
			);
		},
	);

	it("has copy in en.json for every code, and a generic line", () => {
		const messages = JSON.parse(
			readFileSync(
				path.resolve(
					__dirname,
					"../../../../../../../packages/i18n/translations/en.json",
				),
				"utf8",
			),
		);
		const errors =
			messages.projects.contexts.livingMemory.writeFolders.errors;

		for (const code of [...CODES, "INVALID_PATH", "generic"]) {
			expect(typeof errors[code], code).toBe("string");
			expect(errors[code].length, code).toBeGreaterThan(10);
		}
	});

	it("falls back to the generic line for a failure with no code", async () => {
		createMock.mockRejectedValue(new Error("network"));
		const user = userEvent.setup();
		mount();
		await openForm(user);
		await typeFolder(user, "docs/notes");

		await user.click(
			screen.getByRole("button", { name: `${NS}.form.add` }),
		);

		expect(
			await screen.findByTestId("write-folder-error"),
		).toHaveTextContent(`${NS}.errors.generic`);
	});
});

describe("changing and removing", () => {
	it("sends only what changed when a folder is edited", async () => {
		listMock.mockResolvedValue(list({ targets: [target()] }));
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", {
				name: `${NS}.row.edit{"folder":"docs/ai"}`,
			}),
		);

		await typeFolder(user, "docs/notes");
		await user.click(
			screen.getByRole("button", { name: `${NS}.form.save` }),
		);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith({
				projectId: "project_1",
				targetId: "wt_1",
				folder: "docs/notes",
			}),
		);
	});

	it("removes a folder after a confirmation", async () => {
		listMock.mockResolvedValue(list({ targets: [target()] }));
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", {
				name: `${NS}.row.remove{"folder":"docs/ai"}`,
			}),
		);

		const dialog = await screen.findByRole("alertdialog");
		expect(deleteMock).not.toHaveBeenCalled();
		await user.click(
			within(dialog).getByTestId("write-folder-remove-confirm"),
		);

		await waitFor(() =>
			expect(deleteMock).toHaveBeenCalledWith({
				projectId: "project_1",
				targetId: "wt_1",
			}),
		);
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				`${NS}.remove.removed{"folder":"docs/ai"}`,
			),
		);
		await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
	});

	it("says so when a removal fails", async () => {
		listMock.mockResolvedValue(list({ targets: [target()] }));
		deleteMock.mockRejectedValue(new Error("down"));
		const user = userEvent.setup();
		mount();
		await user.click(
			await screen.findByRole("button", {
				name: `${NS}.row.remove{"folder":"docs/ai"}`,
			}),
		);

		await user.click(
			within(await screen.findByRole("alertdialog")).getByTestId(
				"write-folder-remove-confirm",
			),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.errors.generic${JSON.stringify({ path: "", withPath: "", max: 10 })}`,
			),
		);
	});
});

describe("keyboard", () => {
	it("opens the form, adds a typed folder and saves without a pointer", async () => {
		const user = userEvent.setup();
		mount();
		const add = await screen.findByRole("button", { name: `${NS}.add` });
		add.focus();

		await user.keyboard("{Enter}");
		const input = await screen.findByLabelText(`${NS}.picker.typedLabel`);
		input.focus();
		await user.keyboard("docs/notes{Enter}");

		expect(screen.getByTestId("write-folder-chosen")).toHaveTextContent(
			"docs/notes",
		);
		const save = screen.getByRole("button", { name: `${NS}.form.add` });
		save.focus();
		await user.keyboard("{Enter}");

		await waitFor(() =>
			expect(createMock).toHaveBeenCalledWith({
				projectId: "project_1",
				folder: "docs/notes",
				mode: "PULL_REQUEST",
			}),
		);
	});

	it("labels the icon buttons of every row", async () => {
		listMock.mockResolvedValue(list({ targets: [target()] }));

		mount();

		const row = await screen.findByTestId("write-folder-row");
		const buttons = within(row).getAllByRole("button");
		expect(buttons).toHaveLength(2);
		for (const button of buttons) {
			expect(button).toHaveAccessibleName(/docs\/ai/);
		}
	});
});
