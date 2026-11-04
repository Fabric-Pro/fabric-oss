/**
 * "Reset Living Memory" in the Context tab's Living Memory section:
 *  - shown only to a member who may delete any member's context source, in
 *    an organization project with synced files;
 *  - disabled, with the reason as visible text tied to the button, while a
 *    repository sync is connected;
 *  - the confirmation states the scope with the count, and resets only once
 *    the project's name is typed exactly;
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
import { ResetLivingMemory } from "../ResetLivingMemory";

const NS = "projects.contexts.livingMemory.reset";

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

function renderReset(
	overrides: Partial<{
		organizationId: string | null;
		syncedFileCount: number;
		repositorySyncConnected: boolean;
		onReset: () => void;
	}> = {},
) {
	return wrap(
		<ResetLivingMemory
			projectId="project-1"
			organizationId={
				overrides.organizationId === undefined
					? "org-1"
					: overrides.organizationId
			}
			syncedFileCount={overrides.syncedFileCount ?? 3}
			repositorySyncConnected={overrides.repositorySyncConnected ?? false}
			onReset={overrides.onReset ?? vi.fn()}
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

describe("ResetLivingMemory", () => {
	it("is hidden without the permission to delete any member's context source", async () => {
		projectMock.mockResolvedValue({
			project: { name: "Example Project", canDeleteContexts: false },
		});

		renderReset();

		await waitFor(() => expect(projectMock).toHaveBeenCalled());
		expect(screen.queryByTestId("living-memory-reset")).toBeNull();
	});

	it("is hidden with no synced files, and in a personal project", async () => {
		const { unmount } = renderReset({ syncedFileCount: 0 });
		await waitFor(() => expect(projectMock).toHaveBeenCalled());
		expect(screen.queryByTestId("living-memory-reset")).toBeNull();
		unmount();

		renderReset({ organizationId: null });
		expect(screen.queryByTestId("living-memory-reset")).toBeNull();
	});

	it("is disabled with the reason while a repository sync is connected", async () => {
		renderReset({ repositorySyncConnected: true });

		const button = await screen.findByTestId("living-memory-reset");
		expect(button).toBeDisabled();
		const reason = screen.getByText(`${NS}.disabledSyncConnected`);
		expect(button.getAttribute("aria-describedby")).toBe(reason.id);
	});

	it("states the scope and resets only once the project name is typed", async () => {
		const user = userEvent.setup();
		const onReset = vi.fn();
		resetMock.mockResolvedValue({ deleted: 3 });
		renderReset({ onReset });

		await user.click(await screen.findByTestId("living-memory-reset"));
		expect(
			screen.getByText(
				`${NS}.description${JSON.stringify({ count: 3 })}`,
			),
		).toBeInTheDocument();
		const confirm = screen.getByTestId("living-memory-reset-confirm");
		expect(confirm).toBeDisabled();

		await user.type(
			screen.getByTestId("living-memory-reset-name"),
			"example project",
		);
		expect(confirm).toBeDisabled();

		await user.clear(screen.getByTestId("living-memory-reset-name"));
		await user.type(
			screen.getByTestId("living-memory-reset-name"),
			"Example Project",
		);
		expect(confirm).toBeEnabled();
		await user.click(confirm);

		await waitFor(() =>
			expect(resetMock).toHaveBeenCalledWith({ projectId: "project-1" }),
		);
		await waitFor(() => expect(onReset).toHaveBeenCalledTimes(1));
		expect(toast.success).toHaveBeenCalledWith(
			`${NS}.done${JSON.stringify({ count: 3 })}`,
		);
	});

	it("is reachable and confirmable with the keyboard alone", async () => {
		const user = userEvent.setup();
		resetMock.mockResolvedValue({ deleted: 1 });
		renderReset();

		const button = await screen.findByTestId("living-memory-reset");
		button.focus();
		await user.keyboard("{Enter}");
		const input = await screen.findByLabelText(
			`${NS}.confirmLabel${JSON.stringify({ name: "Example Project" })}`,
		);
		input.focus();
		await user.keyboard("Example Project");
		await user.tab();
		await user.tab();
		expect(screen.getByTestId("living-memory-reset-confirm")).toHaveFocus();
		await user.keyboard("{Enter}");

		await waitFor(() => expect(resetMock).toHaveBeenCalledTimes(1));
	});
});
