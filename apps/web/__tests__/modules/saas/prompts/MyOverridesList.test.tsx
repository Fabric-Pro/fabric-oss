/**
 * MyOverridesList (Fizzy #2068 F8): rows render with their action label and a
 * hand-back action that clears through the bind API; the empty state points at
 * the catalog.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/MyOverridesList.test.tsx
 */

import { MyOverridesList } from "@saas/prompts/components/MyOverridesList";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMineMock = vi.fn();
const clearMock = vi.fn();
const confirmMock = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			bind: {
				listMine: {
					queryOptions: () => ({
						queryKey: ["prompts", "bind", "listMine"],
						queryFn: () => listMineMock(),
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: {
				clear: (...args: unknown[]) => clearMock(...args),
			},
		},
	},
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("next/link", () => ({
	default: ({
		href,
		children,
	}: {
		href: string;
		children: React.ReactNode;
	}) => <a href={href}>{children}</a>,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ROW = {
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	storyKind: null,
	actionLabel: "Test Case Drafter — General",
	promptId: "p-1",
	promptName: "My drafter",
	promptVersionId: "pv-1",
	updatedAt: "2026-08-24T00:00:00.000Z",
};

function renderList() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MyOverridesList basePath="/app/acme" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMineMock.mockReset();
	clearMock.mockReset().mockResolvedValue({});
	// `confirm` is callback-based and returns void: it never resolves to a
	// boolean. Confirming means the provider invoking `onConfirm`.
	confirmMock
		.mockReset()
		.mockImplementation((options: { onConfirm: () => void }) =>
			options.onConfirm(),
		);
});

describe("MyOverridesList", () => {
	it("renders each override with its action label, prompt link, and hand-back", async () => {
		listMineMock.mockResolvedValue([ROW]);

		renderList();

		expect(
			await screen.findByText("Test Case Drafter — General"),
		).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "My drafter" });
		expect(link).toHaveAttribute("href", "/app/acme/prompts/p-1");
		expect(
			screen.getByRole("button", { name: "Hand back" }),
		).toBeInTheDocument();
	});

	it("hands a override back through the bind clear API after confirm", async () => {
		listMineMock.mockResolvedValue([ROW]);
		renderList();
		await screen.findByText("Test Case Drafter — General");

		await userEvent.click(
			screen.getByRole("button", { name: "Hand back" }),
		);

		await waitFor(() => {
			expect(clearMock).toHaveBeenCalledWith({
				targetType: "AGENT",
				targetKey: "test_case_drafter",
				documentType: "GENERAL",
				storyKind: null,
				scope: "USER",
			});
		});
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(confirmMock.mock.calls[0][0]).toMatchObject({
			title: "Hand back Test Case Drafter — General?",
			confirmLabel: "Hand back",
		});
	});

	it("does not clear when the confirm is dismissed", async () => {
		listMineMock.mockResolvedValue([ROW]);
		// Dismissing is the provider simply never calling `onConfirm`.
		confirmMock.mockImplementation(() => undefined);
		renderList();
		await screen.findByText("Test Case Drafter — General");

		await userEvent.click(
			screen.getByRole("button", { name: "Hand back" }),
		);

		expect(clearMock).not.toHaveBeenCalled();
	});

	it("points the empty state at the catalog", async () => {
		listMineMock.mockResolvedValue([]);

		renderList();

		const link = await screen.findByRole("link", { name: "catalog" });
		expect(link).toHaveAttribute("href", "/app/acme/prompts/catalog");
		expect(screen.getByText(/No personal overrides/)).toBeInTheDocument();
	});
});
