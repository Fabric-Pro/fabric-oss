/**
 * "Remove coding instructions" in the tab's settings dialog:
 *  - shown only to a member who holds INSTRUCTION_DELETE
 *    (`canDeleteInstructions`), and only when the server counts something to
 *    remove;
 *  - the confirmation names the published version and how many other
 *    versions go with it, counted by the server (`removeAllPreview`), not by
 *    History, and removes only once the project's name is typed exactly;
 *  - while the server would refuse, the button is disabled and the reason is
 *    shown and tied to it with `aria-describedby`;
 *  - on success the dialog is told to close BEFORE every instructions read
 *    is invalidated, so focus returns to the settings trigger first;
 *  - a refusal is shown with the translated line for its reason, never the
 *    server's own message, and removes nothing on screen.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	project: vi.fn(),
	preview: vi.fn(),
	removeAll: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryOptions: (options: Record<string, unknown>) => ({
					...options,
					queryKey: ["projects", "get"],
					queryFn: () => m.project(),
				}),
			},
			instructions: {
				key: () => ["projects", "instructions"],
				removeAllPreview: {
					queryOptions: (options: Record<string, unknown>) => ({
						...options,
						queryKey: [
							"projects",
							"instructions",
							"removeAllPreview",
						],
						queryFn: () => m.preview(),
					}),
				},
				removeAll: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: (input: unknown) => m.removeAll(input),
						...opts,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
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

import { toast } from "sonner";
import { RemoveCodingInstructions } from "../RemoveCodingInstructions";

const NS = "projects.codingInstructions.settingsDialog.remove";
const ERRORS = "projects.codingInstructions.actionErrors";

function wrap(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	return {
		invalidate,
		...render(
			<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
		),
	};
}

function renderRemove(onRemoved = vi.fn()) {
	return {
		onRemoved,
		...wrap(
			<RemoveCodingInstructions
				projectId="project-1"
				onRemoved={onRemoved}
			/>,
		),
	};
}

async function openAndType(name: string) {
	await userEvent.click(await screen.findByTestId("instructions-remove"));
	await userEvent.type(
		await screen.findByTestId("instructions-remove-name"),
		name,
	);
}

beforeEach(() => {
	for (const f of [m.project, m.preview, m.removeAll]) {
		f.mockReset();
	}
	vi.mocked(toast.success).mockReset();
	vi.mocked(toast.error).mockReset();
	m.project.mockResolvedValue({
		project: { name: "Example Project", canDeleteInstructions: true },
	});
	m.preview.mockResolvedValue({
		snapshotCount: 5,
		publishedVersion: 3,
		blockedBy: null,
	});
	m.removeAll.mockResolvedValue({
		removed: 5,
		publishedVersion: 3,
		storageCleanupPending: false,
	});
});

describe("RemoveCodingInstructions", () => {
	it("is hidden, and asks the server nothing, without the permission to delete coding instructions", async () => {
		m.project.mockResolvedValue({
			project: { name: "Example Project", canDeleteInstructions: false },
		});

		renderRemove();

		await waitFor(() => expect(m.project).toHaveBeenCalled());
		expect(screen.queryByTestId("instructions-remove")).toBeNull();
		expect(m.preview).not.toHaveBeenCalled();
	});

	it("is hidden when the server counts nothing to remove", async () => {
		m.preview.mockResolvedValue({
			snapshotCount: 0,
			publishedVersion: null,
			blockedBy: null,
		});

		renderRemove();

		await waitFor(() => expect(m.preview).toHaveBeenCalled());
		expect(screen.queryByTestId("instructions-remove")).toBeNull();
	});

	it("names the published version and the server's count of the other versions", async () => {
		renderRemove();

		await userEvent.click(await screen.findByTestId("instructions-remove"));

		expect(
			await screen.findByText(
				`${NS}.description${JSON.stringify({ version: 3, count: 4 })}`,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				`${NS}.confirmLabel${JSON.stringify({ name: "Example Project" })}`,
			),
		).toBeInTheDocument();
	});

	it("counts every version when nothing is published", async () => {
		m.preview.mockResolvedValue({
			snapshotCount: 2,
			publishedVersion: null,
			blockedBy: null,
		});

		renderRemove();
		await userEvent.click(await screen.findByTestId("instructions-remove"));

		expect(
			await screen.findByText(
				`${NS}.descriptionNothingPublished${JSON.stringify({ count: 2 })}`,
			),
		).toBeInTheDocument();
	});

	it.each([
		["REPOSITORY_MODE", `${ERRORS}.repositoryMode`],
		["MIGRATION_OPEN", `${NS}.blockedMigrationOpen`],
		["SNAPSHOT_ACTIVE", `${ERRORS}.snapshotActive`],
		["PULL_REQUEST_UNRESOLVED", `${ERRORS}.pullRequestUnresolved`],
		["PROPOSAL_PENDING", `${ERRORS}.proposalPending`],
	])(
		"disables the button and says why while the server would refuse for %s",
		async (blockedBy, line) => {
			m.preview.mockResolvedValue({
				snapshotCount: 3,
				publishedVersion: 3,
				blockedBy,
			});

			renderRemove();

			const button = await screen.findByTestId("instructions-remove");
			expect(button).toBeDisabled();
			const reason = screen.getByTestId("instructions-remove-blocked");
			expect(reason).toHaveTextContent(line);
			expect(button).toHaveAttribute("aria-describedby", reason.id);
			await userEvent.click(button);
			expect(screen.queryByTestId("instructions-remove-name")).toBeNull();
		},
	);

	it("offers the button with no reason when nothing stands in the way", async () => {
		renderRemove();

		const button = await screen.findByTestId("instructions-remove");
		expect(button).toBeEnabled();
		expect(button).not.toHaveAttribute("aria-describedby");
		expect(screen.queryByTestId("instructions-remove-blocked")).toBeNull();
	});

	it("removes only once the project's name is typed exactly", async () => {
		renderRemove();

		await openAndType("Example Projec");
		const confirm = screen.getByTestId("instructions-remove-confirm");
		expect(confirm).toBeDisabled();
		await userEvent.click(confirm);
		expect(m.removeAll).not.toHaveBeenCalled();

		await userEvent.type(
			screen.getByTestId("instructions-remove-name"),
			"t",
		);
		expect(confirm).toBeEnabled();
	});

	it("tells the dialog to close before invalidating every instructions read", async () => {
		const order: string[] = [];
		const onRemoved = vi.fn(() => {
			order.push("onRemoved");
		});
		const { invalidate } = renderRemove(onRemoved);
		invalidate.mockImplementation(async () => {
			order.push("invalidate");
		});

		await openAndType("Example Project");
		await userEvent.click(
			screen.getByTestId("instructions-remove-confirm"),
		);

		await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
		expect(m.removeAll).toHaveBeenCalledWith({ projectId: "project-1" });
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["projects", "instructions"],
		});
		expect(order).toEqual(["onRemoved", "invalidate"]);
		expect(toast.success).toHaveBeenCalledWith(
			`${NS}.done${JSON.stringify({ count: 5 })}`,
		);
	});

	it("words a refusal by its reason, never with the server's message, and keeps the dialog open", async () => {
		m.removeAll.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "CONFLICT",
				data: { reason: "PROPOSAL_PENDING" },
			}),
		);
		const { onRemoved } = renderRemove();

		await openAndType("Example Project");
		await userEvent.click(
			screen.getByTestId("instructions-remove-confirm"),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				`${NS}.failed${JSON.stringify({ reason: `${ERRORS}.proposalPending` })}`,
			),
		);
		expect(onRemoved).not.toHaveBeenCalled();
		expect(screen.getByTestId("instructions-remove-confirm")).toBeVisible();
	});
});
