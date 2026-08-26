/**
 * When "Clear Default Override" is on offer, and what it sends.
 *
 * Only an override can be cleared. A SYSTEM binding is the baseline the other
 * tiers fall back TO, so offering it here would leave the action with no prompt
 * at all rather than reverting it to something — and the library grid, which
 * has no binding context, must not offer it either.
 */

import { PromptCard } from "@saas/prompts/components/PromptCard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { bindClear, confirmMock } = vi.hoisted(() => ({
	bindClear: vi.fn(),
	confirmMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			bind: {
				clear: (input: unknown) => bindClear(input),
				set: vi.fn(),
			},
			get: { byId: vi.fn().mockResolvedValue(null) },
			delete: vi.fn(),
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/acme",
		organizationId: "org-1",
	}),
}));

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }));

// The card mounts SetAsDefaultDialog, which reads the session to decide whether
// to offer the universal tier. Not what these tests are about.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: null } }),
}));

const prompt = {
	id: "p-1",
	name: "Test prompt",
	description: null,
	scope: "ORG" as const,
	format: "PLAIN_TEXT" as const,
	category: null,
	tags: [],
	isPublic: false,
	usageCount: 0,
	lastUsedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	versions: [{ id: "pv-1", version: 1, content: "body" }],
};

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

/**
 * Open the card's action menu.
 *
 * Asserts a known item is on screen afterwards. Without that, the two
 * "is absent" tests below would pass just as happily against a menu that never
 * opened — proving nothing at all.
 */
async function openMenu() {
	const user = userEvent.setup();
	const trigger = document.querySelector(
		'[aria-haspopup="menu"]',
	) as HTMLElement | null;
	if (!trigger) {
		throw new Error("card action menu trigger not found");
	}
	await user.click(trigger);
	expect(await screen.findByText(/duplicate/i)).toBeInTheDocument();
	return user;
}

describe("PromptCard — Clear Default Override", () => {
	beforeEach(() => {
		bindClear.mockReset();
		bindClear.mockResolvedValue({ cleared: true });
		confirmMock.mockReset();
		// Run the confirmation immediately so the test exercises the action,
		// not the dialog.
		confirmMock.mockImplementation(({ onConfirm }: any) => onConfirm());
	});

	it("is absent in the library grid, which has no binding context", async () => {
		wrap(<PromptCard prompt={prompt} />);
		await openMenu();

		expect(
			screen.queryByText(/clear default override/i),
		).not.toBeInTheDocument();
	});

	it("is absent for a SYSTEM binding", async () => {
		wrap(
			<PromptCard
				prompt={prompt}
				binding={{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					scope: "SYSTEM",
				}}
			/>,
		);
		await openMenu();

		expect(
			screen.queryByText(/clear default override/i),
		).not.toBeInTheDocument();
	});

	it("clears an org override at org scope", async () => {
		wrap(
			<PromptCard
				prompt={prompt}
				binding={{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					scope: "ORG",
				}}
			/>,
		);
		const user = await openMenu();
		await user.click(screen.getByText(/clear default override/i));

		expect(bindClear).toHaveBeenCalledWith(
			expect.objectContaining({
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: "DRAFT",
				scope: "ORG",
				organizationId: "org-1",
			}),
		);
	});

	it("clears a personal override without an organization", async () => {
		wrap(
			<PromptCard
				prompt={{ ...prompt, scope: "USER" }}
				binding={{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					scope: "USER",
				}}
			/>,
		);
		const user = await openMenu();
		await user.click(screen.getByText(/clear default override/i));

		expect(bindClear).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "USER",
				// A personal override is not org-scoped, whatever org is active.
				organizationId: null,
			}),
		);
	});

	it("carries the stage kind so the right binding bucket is cleared", async () => {
		wrap(
			<PromptCard
				prompt={prompt}
				storyKindContext="FEATURE"
				binding={{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					scope: "ORG",
				}}
			/>,
		);
		const user = await openMenu();
		await user.click(screen.getByText(/clear default override/i));

		expect(bindClear).toHaveBeenCalledWith(
			expect.objectContaining({ storyKind: "FEATURE" }),
		);
	});

	it("asks for confirmation before clearing", async () => {
		wrap(
			<PromptCard
				prompt={prompt}
				binding={{
					targetKey: "project_document_generator",
					documentType: "DRAFT",
					scope: "ORG",
				}}
			/>,
		);
		const user = await openMenu();
		await user.click(screen.getByText(/clear default override/i));

		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Clear Default Override" }),
		);
	});
});
