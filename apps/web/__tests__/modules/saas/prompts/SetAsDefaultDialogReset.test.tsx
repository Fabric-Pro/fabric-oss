/**
 * What the dialog forgets when it closes.
 *
 * Every field here contributes to a write that can change what an agent runs,
 * so a value surviving from a previous visit is a binding the user did not
 * choose in this one. The tier is reset already; the agent and document type
 * were not, and they are the two that decide WHICH action gets rebound.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/SetAsDefaultDialogReset.test.tsx
 */

import { SetAsDefaultDialog } from "@saas/prompts/components/SetAsDefaultDialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindSet, listForPrompt } = vi.hoisted(() => ({
	bindSet: vi.fn(),
	listForPrompt: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: {
				set: (i: unknown) => bindSet(i),
				setMany: vi.fn(),
				listForPrompt: (i: unknown) => listForPrompt(i),
			},
			nominations: { create: vi.fn() },
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "admin" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: true }),
}));

function renderDialog(open: boolean) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const ui = (isOpen: boolean) => (
		<QueryClientProvider client={client}>
			<SetAsDefaultDialog
				open={isOpen}
				onOpenChange={() => {}}
				promptName="Test prompt"
				promptVersionId="pv-1"
				promptId="p-1"
				initialDocumentType="GENERAL"
			/>
		</QueryClientProvider>
	);
	const utils = render(ui(open));
	return {
		...utils,
		setOpen: (next: boolean) => utils.rerender(ui(next)),
	};
}

const pick = async (
	user: ReturnType<typeof userEvent.setup>,
	label: RegExp,
	option: RegExp,
) => {
	await user.click(await screen.findByRole("combobox", { name: label }));
	await user.click(await screen.findByRole("option", { name: option }));
};

beforeEach(() => {
	bindSet.mockReset();
	bindSet.mockResolvedValue({ id: "b1" });
	listForPrompt.mockReset();
	listForPrompt.mockResolvedValue({ actions: [] });
});

describe("SetAsDefaultDialog — state left behind on close", () => {
	it("forgets a changed agent when reopened", async () => {
		const user = userEvent.setup();
		const { setOpen } = renderDialog(true);

		const agent = await screen.findByRole("combobox", { name: /agent/i });
		const original = agent.textContent;

		await pick(user, /agent/i, /test case step reviser/i);
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /agent/i }).textContent,
			).toMatch(/step reviser/i),
		);

		setOpen(false);
		setOpen(true);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /agent/i }).textContent,
			).toBe(original),
		);
	});

	it("forgets a changed document type when reopened", async () => {
		const user = userEvent.setup();
		const { setOpen } = renderDialog(true);

		// project_document_generator offers several document types, so there is
		// something other than the initial one to pick.
		await pick(user, /agent/i, /project document generator/i);
		// Anchored: more than one document type contains the word.
		await pick(user, /document type/i, /^Architecture$/i);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /document type/i })
					.textContent,
			).toMatch(/architecture/i),
		);

		setOpen(false);
		setOpen(true);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /document type/i })
					.textContent,
			).not.toMatch(/architecture/i),
		);
	});

	it("still forgets the tier, which was already reset", async () => {
		const user = userEvent.setup();
		const { setOpen } = renderDialog(true);

		await pick(user, /scope/i, /system/i);
		setOpen(false);
		setOpen(true);

		await waitFor(() =>
			expect(
				screen.getByRole("combobox", { name: /scope/i }).textContent,
			).toMatch(/my prompts/i),
		);
	});
});
