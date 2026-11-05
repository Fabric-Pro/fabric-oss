import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { context, governance, skill } from "./fixtures";

const h = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	getPolicy: vi.fn(),
	updatePolicy: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		skills: {
			list: h.list,
			get: h.get,
			governance: { get: h.getPolicy, update: h.updatePolicy },
		},
	},
}));
vi.mock("../SkillsHero", () => ({ SkillsHero: () => <h1>Skills</h1> }));
vi.mock("@saas/settings/components/SettingsHero", () => ({
	SettingsHero: ({
		title,
		description,
	}: {
		title: string;
		description: string;
	}) => (
		<header>
			<h1>{title}</h1>
			<p>{description}</p>
		</header>
	),
}));

import { SkillGovernanceSettings } from "../SkillGovernanceSettings";
import { SkillsLibrary } from "../SkillsLibrary";

function wrapper({ children }: { children: ReactNode }) {
	return (
		<NuqsTestingAdapter>
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: {
							queries: { retry: false },
							mutations: { retry: false },
						},
					})
				}
			>
				{children}
			</QueryClientProvider>
		</NuqsTestingAdapter>
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.list.mockImplementation(async () => ({
		skills: [skill],
		total: 60,
		hasMore: true,
		nextCursor: null,
	}));
	h.getPolicy.mockResolvedValue(governance);
	h.get.mockResolvedValue({ skill });
	h.updatePolicy.mockImplementation(async (value) => ({
		...governance,
		policy: value.policy,
		revision: 4,
	}));
});
it("opens details in a closeable sheet while preserving the library collection, search, and page", async () => {
	const updates = vi.fn();
	const v = render(
		<NuqsTestingAdapter
			searchParams="?tab=drafts&search=delivery&page=2"
			hasMemory
			onUrlUpdate={updates}
		>
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<SkillsLibrary />
			</QueryClientProvider>
		</NuqsTestingAdapter>,
	);
	const card = await v.findByRole("link", { name: /Delivery update/ });
	card.focus();
	fireEvent.click(card);
	const details = await v.findByRole("dialog", { name: "Skill details" });
	await waitFor(() =>
		expect(h.get).toHaveBeenCalledWith({
			id: skill.id,
			organizationId: context.organizationId,
		}),
	);
	expect(details).toHaveTextContent(skill.description);
	expect(v.getByRole("link", { name: "Edit", exact: true })).toHaveAttribute(
		"href",
		`/app/example-org/skills/${skill.id}/edit?returnTo=${encodeURIComponent("/app/example-org/skills?tab=drafts&search=delivery&page=2")}`,
	);
	expect(updates.mock.calls.at(-1)?.[0].searchParams.get("tab")).toBe(
		"drafts",
	);
	expect(updates.mock.calls.at(-1)?.[0].searchParams.get("search")).toBe(
		"delivery",
	);
	expect(updates.mock.calls.at(-1)?.[0].searchParams.get("page")).toBe("2");
	fireEvent.click(v.getByRole("button", { name: "Close", exact: true }));
	await waitFor(() =>
		expect(
			v.queryByRole("dialog", { name: "Skill details" }),
		).not.toBeInTheDocument(),
	);
	const params = updates.mock.calls.at(-1)?.[0].searchParams;
	expect(params.get("skill")).toBeNull();
	expect(params.get("tab")).toBe("drafts");
	expect(params.get("search")).toBe("delivery");
	expect(params.get("page")).toBe("2");
	expect(v.getByPlaceholderText("Search skills…")).toHaveValue("delivery");
	expect(card).toHaveFocus();
});
it("paginates on the server beyond the first fifty and has no personal scope", async () => {
	const v = render(<SkillsLibrary />, { wrapper });
	await v.findByRole("heading", { name: "Delivery update" });
	expect(h.list).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: context.organizationId,
			tab: "organization",
			limit: 20,
			offset: 0,
		}),
	);
	expect(v.queryByText("Personal")).not.toBeInTheDocument();
	fireEvent.click(v.getByRole("button", { name: "Next page" }));
	await waitFor(() =>
		expect(h.list).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 20 }),
		),
	);
	expect(v.getByLabelText("Skill collections")).toBeInTheDocument();
});
it("advertises the three actual creation paths only after current policy permits creation", async () => {
	const v = render(<SkillsLibrary />, { wrapper });
	await waitFor(() =>
		expect(v.getByRole("button", { name: "Create skill" })).toBeEnabled(),
	);
	fireEvent.keyDown(v.getByRole("button", { name: "Create skill" }), {
		key: "Enter",
	});
	expect(
		await v.findByRole("menuitem", { name: "From conversation" }),
	).toHaveAttribute("href", "/app/example-org/skills/new?mode=conversation");
	expect(v.getByRole("menuitem", { name: "From scratch" })).toHaveAttribute(
		"href",
		"/app/example-org/skills/new",
	);
	expect(
		v.getByRole("menuitem", { name: "From existing" }),
	).toBeInTheDocument();
});
it("never offers creation when governance or role forbids it", async () => {
	h.getPolicy.mockResolvedValue({
		...governance,
		capabilities: { ...governance.capabilities, canCreate: false },
	});
	const v = render(<SkillsLibrary />, { wrapper });
	await v.findByText(/does not permit creating skills/);
	expect(v.getByRole("button", { name: "Create skill" })).toBeDisabled();
});
it("uses archived collection as an actual authorized server filter", async () => {
	const v = render(<SkillsLibrary />, { wrapper });
	await v.findByRole("heading", { name: "Delivery update" });
	fireEvent.mouseDown(v.getByRole("tab", { name: "Archived" }), {
		button: 0,
		ctrlKey: false,
	});
	await waitFor(() =>
		expect(h.list).toHaveBeenCalledWith(
			expect.objectContaining({ tab: "archived", offset: 0 }),
		),
	);
});
it("does not preserve cached catalog entries after a current read refusal", async () => {
	h.list.mockRejectedValueOnce(
		Object.assign(new Error("Access changed"), { code: "FORBIDDEN" }),
	);
	const v = render(<SkillsLibrary />, { wrapper });
	await v.findByText("Access changed");
	expect(
		v.queryByRole("heading", { name: "Delivery update" }),
	).not.toBeInTheDocument();
});
it("keeps governance edits local until Save, with expected revision CAS", async () => {
	const v = render(
		<SkillGovernanceSettings organizationId={context.organizationId} />,
		{ wrapper },
	);
	const combo = await v.findByLabelText("Create skills");
	fireEvent.keyDown(combo, { key: "ArrowDown" });
	fireEvent.click(await v.findByRole("option", { name: "Admins only" }));
	expect(h.updatePolicy).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Save policy" }));
	await waitFor(() =>
		expect(h.updatePolicy).toHaveBeenCalledWith({
			organizationId: context.organizationId,
			expectedRevision: 3,
			policy: { ...governance.policy, create: "administrators" },
		}),
	);
});
it("allows read-only members to inspect policy without fake Groups or writes", async () => {
	h.getPolicy.mockResolvedValue({ ...governance, canManage: false });
	const v = render(
		<SkillGovernanceSettings organizationId={context.organizationId} />,
		{ wrapper },
	);
	await v.findByText(
		"Only organization owners and admins can update this policy.",
	);
	for (const combo of v.getAllByRole("combobox")) {
		expect(combo).toBeDisabled();
	}
	expect(
		v.queryByRole("button", { name: "Save policy" }),
	).not.toBeInTheDocument();
	expect(v.queryByText("Groups")).not.toBeInTheDocument();
	expect(h.updatePolicy).not.toHaveBeenCalled();
	expect(
		(
			await axe(v.container, {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});
it("Cancel restores the current policy without a write", async () => {
	const v = render(
		<SkillGovernanceSettings organizationId={context.organizationId} />,
		{ wrapper },
	);
	const combo = await v.findByLabelText("Create skills");
	fireEvent.keyDown(combo, { key: "ArrowDown" });
	fireEvent.click(await v.findByRole("option", { name: "Admins only" }));
	fireEvent.click(v.getByRole("button", { name: "Cancel" }));
	expect(v.getByRole("button", { name: "Save policy" })).toBeDisabled();
	expect(h.updatePolicy).not.toHaveBeenCalled();
});
