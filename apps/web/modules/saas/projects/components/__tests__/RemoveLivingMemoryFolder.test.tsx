/**
 * "Remove folder" on one Living Memory folder:
 *  - shown only to a member who may delete any member's context source, in
 *    an organization project, for a folder with synced files, never for the
 *    project root and never while a repository sync is connected;
 *  - the confirmation names the folder and its file count, and removes only
 *    once the folder is typed exactly, sending the folder with the request;
 *  - on success the parent refreshes and the count is announced.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resetMock, projectMock } = vi.hoisted(() => ({
	resetMock: vi.fn(),
	projectMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: (options: Record<string, unknown>) => ({
					...options,
					queryKey: ["project"],
					queryFn: () => projectMock(),
				}),
			},
			contexts: {
				resetLivingMemory: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: (input: unknown) => resetMock(input),
						...opts,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("next-intl", () => ({
	useTranslations:
		(namespace: string) =>
		(key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { RemoveLivingMemoryFolder } from "../RemoveLivingMemoryFolder";

const NS = "projects.contexts.livingMemory.removeFolder";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function renderRemove(
	overrides: Partial<{
		organizationId: string | null;
		folderPath: string;
		fileCount: number;
		repositorySyncConnected: boolean;
		onRemoved: () => void;
	}> = {},
) {
	return wrap(
		<RemoveLivingMemoryFolder
			projectId="project-1"
			organizationId={
				overrides.organizationId === undefined
					? "org-1"
					: overrides.organizationId
			}
			folderPath={overrides.folderPath ?? "docs"}
			fileCount={overrides.fileCount ?? 3}
			repositorySyncConnected={overrides.repositorySyncConnected ?? false}
			onRemoved={overrides.onRemoved ?? vi.fn()}
		/>,
	);
}

beforeEach(() => {
	resetMock.mockReset();
	projectMock.mockReset();
	projectMock.mockResolvedValue({
		project: { name: "Example Project", canDeleteContexts: true },
	});
	vi.mocked(toast.success).mockReset();
});

describe("RemoveLivingMemoryFolder", () => {
	it("is hidden without the permission to delete any member's context source", async () => {
		projectMock.mockResolvedValue({
			project: { name: "Example Project", canDeleteContexts: false },
		});

		renderRemove();

		await waitFor(() => expect(projectMock).toHaveBeenCalled());
		expect(screen.queryByTestId("living-memory-remove-folder")).toBeNull();
	});

	it.each([
		["the project root", { folderPath: "" }],
		["a folder with no synced files", { fileCount: 0 }],
		["a connected repository sync", { repositorySyncConnected: true }],
		["a personal project", { organizationId: null }],
	])("is hidden for %s", async (_label, overrides) => {
		renderRemove(overrides);

		await waitFor(() => expect(projectMock).toHaveBeenCalled());
		expect(screen.queryByTestId("living-memory-remove-folder")).toBeNull();
	});

	it("names the folder and its count, and removes only once the folder is typed", async () => {
		const user = userEvent.setup();
		const onRemoved = vi.fn();
		resetMock.mockResolvedValue({ deleted: 3 });
		renderRemove({ folderPath: "docs/guides", onRemoved });

		await user.click(
			await screen.findByRole("button", {
				name: `${NS}.actionLabel${JSON.stringify({ folder: "docs/guides" })}`,
			}),
		);
		expect(
			screen.getByText(
				`${NS}.title${JSON.stringify({ folder: "docs/guides" })}`,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				`${NS}.description${JSON.stringify({ folder: "docs/guides", count: 3 })}`,
			),
		).toBeInTheDocument();
		const confirm = screen.getByTestId(
			"living-memory-remove-folder-confirm",
		);
		expect(confirm).toBeDisabled();

		await user.type(
			screen.getByTestId("living-memory-remove-folder-name"),
			"docs",
		);
		expect(confirm).toBeDisabled();

		await user.clear(
			screen.getByTestId("living-memory-remove-folder-name"),
		);
		await user.type(
			screen.getByTestId("living-memory-remove-folder-name"),
			"docs/guides",
		);
		expect(confirm).toBeEnabled();
		await user.click(confirm);

		await waitFor(() =>
			expect(resetMock).toHaveBeenCalledWith({
				projectId: "project-1",
				folder: "docs/guides",
			}),
		);
		await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
		expect(toast.success).toHaveBeenCalledWith(
			`${NS}.done${JSON.stringify({ folder: "docs/guides", count: 3 })}`,
		);
	});

	it("is reachable and confirmable with the keyboard alone", async () => {
		const user = userEvent.setup();
		resetMock.mockResolvedValue({ deleted: 1 });
		renderRemove();

		const button = await screen.findByTestId("living-memory-remove-folder");
		button.focus();
		await user.keyboard("{Enter}");
		const input = await screen.findByLabelText(
			`${NS}.confirmLabel${JSON.stringify({ folder: "docs" })}`,
		);
		input.focus();
		await user.keyboard("docs");
		await user.tab();
		await user.tab();
		expect(
			screen.getByTestId("living-memory-remove-folder-confirm"),
		).toHaveFocus();
		await user.keyboard("{Enter}");

		await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
	});
});
