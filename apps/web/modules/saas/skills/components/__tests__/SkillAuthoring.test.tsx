import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { context, governance, skill } from "./fixtures";

const h = vi.hoisted(() => ({
	getPolicy: vi.fn(),
	create: vi.fn(),
	update: vi.fn(),
	assist: vi.fn(),
	publish: vi.fn(),
	archive: vi.fn(),
	restore: vi.fn(),
	replace: vi.fn(),
	push: vi.fn(),
	file: vi.fn(),
	list: vi.fn(),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
	}),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: h.replace, push: h.push }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		skills: {
			list: h.list,
			governance: { get: h.getPolicy },
			create: h.create,
			update: h.update,
			assist: h.assist,
			publish: h.publish,
			archive: h.archive,
			restore: h.restore,
			files: { read: h.file },
		},
	},
}));

import { SkillAssistant } from "../SkillAssistant";
import { SkillAvailability } from "../SkillAvailability";
import { SkillEditor } from "../SkillEditor";
import { SkillViewer } from "../SkillViewer";

function wrapper({ children }: { children: ReactNode }) {
	return (
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
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	h.getPolicy.mockResolvedValue(governance);
	h.list.mockResolvedValue({
		skills: [],
		total: 0,
		hasMore: false,
		nextCursor: null,
	});
	h.create.mockImplementation(async (values) => ({
		skill: { ...skill, ...values, id: "example-created" },
	}));
	h.update.mockImplementation(async (values) => ({
		skill: { ...skill, ...values, version: 3 },
	}));
	h.publish.mockResolvedValue({
		skill: {
			...skill,
			availability: "members",
			isPublished: true,
			version: 3,
		},
	});
	h.archive.mockResolvedValue({
		skill: { ...skill, archivedAt: "2026-01-03T00:00:00Z" },
	});
	h.restore.mockResolvedValue({ skill });
	h.assist.mockResolvedValue({
		message: "Review this focused skill draft.",
		proposal: {
			name: skill.name,
			slug: skill.slug,
			description: skill.description,
			content: skill.content,
			tags: skill.tags,
		},
	});
});
it("creates only an explicit owner draft and does not call AI on opening", async () => {
	const v = render(<SkillEditor />, { wrapper });
	await waitFor(() => expect(v.getByLabelText("Skill name")).toBeEnabled());
	expect(h.assist).not.toHaveBeenCalled();
	expect(h.create).not.toHaveBeenCalled();
	fireEvent.change(v.getByLabelText("Skill name"), {
		target: { value: "Delivery update" },
	});
	fireEvent.change(v.getByLabelText("When to use this skill"), {
		target: { value: skill.description },
	});
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: skill.content },
	});
	fireEvent.click(v.getByRole("button", { name: "Save draft" }));
	await waitFor(() =>
		expect(h.create).toHaveBeenCalledWith({
			organizationId: context.organizationId,
			name: skill.name,
			slug: skill.slug,
			description: skill.description,
			content: skill.content,
			category: undefined,
			tags: [],
			isPublished: false,
			isDiscoverable: false,
		}),
	);
	expect(h.publish).not.toHaveBeenCalled();
	expect(h.replace).toHaveBeenCalledWith(
		"/app/example-org/skills/example-created/edit",
	);
});
it("opens conversational authoring with a useful question and waits for Send and Apply", async () => {
	const v = render(<SkillEditor mode="conversation" />, { wrapper });
	await v.findByText("What should this skill help your team do?");
	expect(h.assist).not.toHaveBeenCalled();
	const dialog = v.getByRole("dialog");
	fireEvent.change(within(dialog).getByLabelText("Message skill assistant"), {
		target: { value: "Draft delivery update instructions" },
	});
	await waitFor(() =>
		expect(
			within(dialog).getByRole("button", { name: "Send request" }),
		).toBeEnabled(),
	);
	fireEvent.click(
		within(dialog).getByRole("button", { name: "Send request" }),
	);
	await v.findByRole("button", { name: "Apply proposal to draft" });
	expect(v.getByLabelText("Skill name")).toHaveValue("");
	expect(h.create).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Apply proposal to draft" }));
	expect(v.getByLabelText("Skill name")).toHaveValue(skill.name);
	expect(v.getByLabelText("Instructions")).toHaveValue(skill.content);
	expect(h.create).not.toHaveBeenCalled();
	expect(h.update).not.toHaveBeenCalled();
});
it("does not apply a stale assistant proposal after the draft changed", async () => {
	const draft = {
		name: skill.name,
		slug: skill.slug,
		description: skill.description,
		content: skill.content,
		tags: [],
	};
	const onApply = vi.fn();
	const v = render(
		<SkillAssistant
			organizationId={context.organizationId}
			open
			onOpenChange={() => undefined}
			draft={draft}
			onApply={onApply}
			canCreate
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByLabelText("Message skill assistant"), {
		target: { value: "Improve it" },
	});
	fireEvent.click(v.getByRole("button", { name: "Send request" }));
	await v.findByRole("button", { name: "Apply proposal to draft" });
	v.rerender(
		<SkillAssistant
			organizationId={context.organizationId}
			open
			onOpenChange={() => undefined}
			draft={{ ...draft, content: "Changed manually" }}
			onApply={onApply}
			canCreate
		/>,
	);
	expect(
		v.getByRole("button", { name: "Apply proposal to draft" }),
	).toBeDisabled();
	expect(onApply).not.toHaveBeenCalled();
});
it("uses the captured version for edit CAS and preserves unsaved edits on a refreshed version", async () => {
	const v = render(<SkillEditor skill={skill} />, { wrapper });
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: "My unsaved process" },
	});
	v.rerender(
		<SkillEditor
			skill={{
				...skill,
				version: 3,
				content: "Someone else's saved process",
			}}
		/>,
	);
	expect(v.getByLabelText("Instructions")).toHaveValue("My unsaved process");
	expect(
		v.getByText("This skill changed while you were editing"),
	).toBeInTheDocument();
	expect(v.getByRole("button", { name: "Save changes" })).toBeDisabled();
	expect(h.update).not.toHaveBeenCalled();
});
it("asks before discarding edits when the X closes the editor", async () => {
	const v = render(<SkillEditor skill={skill} />, { wrapper });
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: "Changed instructions" },
	});
	fireEvent.click(v.getByRole("button", { name: "Close skill editor" }));
	expect(v.getByRole("alertdialog")).toBeInTheDocument();
	expect(h.push).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Keep editing" }));
	expect(v.getByLabelText("Instructions")).toHaveValue(
		"Changed instructions",
	);
});
it("returns to the validated filtered library after explicitly discarding edits", async () => {
	const returnTo =
		"/app/example-org/skills?tab=drafts&search=delivery&page=2";
	const v = render(<SkillEditor skill={skill} returnTo={returnTo} />, {
		wrapper,
	});
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: "Unsaved revision" },
	});
	fireEvent.click(v.getByRole("button", { name: "Close skill editor" }));
	expect(h.push).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Discard changes" }));
	expect(h.push).toHaveBeenCalledWith(returnTo);
});
it("checks authoring access without flashing a denial or enabling requests before permissions resolve", async () => {
	let resolvePolicy: (value: typeof governance) => void = () => undefined;
	h.getPolicy.mockReturnValue(
		new Promise<typeof governance>((resolve) => {
			resolvePolicy = resolve;
		}),
	);
	const v = render(<SkillEditor mode="conversation" />, { wrapper });
	expect(v.getByText("Checking authoring permissions…")).toBeInTheDocument();
	expect(
		v.queryByText(
			"Your current role or policy does not allow authoring skills.",
		),
	).not.toBeInTheDocument();
	fireEvent.change(v.getByLabelText("Message skill assistant"), {
		target: { value: "Help improve the instructions" },
	});
	expect(v.getByRole("button", { name: "Send request" })).toBeDisabled();
	expect(h.assist).not.toHaveBeenCalled();
	resolvePolicy(governance);
	await waitFor(() =>
		expect(v.getByRole("button", { name: "Send request" })).toBeEnabled(),
	);
	expect(
		v.queryByText("Checking authoring permissions…"),
	).not.toBeInTheDocument();
	expect(h.assist).not.toHaveBeenCalled();
});
it("disables authoring when current role or policy forbids creation", async () => {
	h.getPolicy.mockResolvedValue({
		...governance,
		capabilities: { ...governance.capabilities, canCreate: false },
	});
	const v = render(<SkillEditor />, { wrapper });
	await v.findByText("Editing is not available");
	expect(v.getByLabelText("Instructions")).toBeDisabled();
	expect(v.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(h.create).not.toHaveBeenCalled();
});
it("blocks another create after an unconfirmed response even when the identifier changes, until a draft read and explicit review", async () => {
	h.create.mockRejectedValueOnce(new Error("Create response was lost"));
	const v = render(<SkillEditor />, { wrapper });
	await waitFor(() => expect(v.getByLabelText("Skill name")).toBeEnabled());
	fireEvent.change(v.getByLabelText("Skill name"), {
		target: { value: "Example delivery draft" },
	});
	fireEvent.change(v.getByLabelText("When to use this skill"), {
		target: { value: "Review a delivery report." },
	});
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: "Read the supplied evidence and list risks." },
	});
	fireEvent.click(v.getByRole("button", { name: "Save draft" }));
	await v.findByText("Check whether your draft was saved");
	fireEvent.change(v.getByLabelText("Skill name"), {
		target: { value: "Changed name and identifier" },
	});
	expect(v.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(h.create).toHaveBeenCalledTimes(1);
	expect(h.list).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Check saved drafts" }));
	fireEvent.click(
		await v.findByRole("button", {
			name: "I reviewed drafts; allow another attempt",
		}),
	);
	expect(h.list).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: "example-org",
			tab: "drafts",
			search: "example-delivery-draft",
		}),
	);
	expect(h.create).toHaveBeenCalledTimes(1);
	fireEvent.click(v.getByRole("button", { name: "Save draft" }));
	await waitFor(() => expect(h.create).toHaveBeenCalledTimes(2));
});
it("opens an existing matching draft after an uncertain create instead of offering another create", async () => {
	h.create.mockRejectedValueOnce(new Error("Create response was lost"));
	h.list.mockResolvedValue({
		skills: [{ ...skill, slug: "example-delivery-draft" }],
		total: 1,
		hasMore: false,
		nextCursor: null,
	});
	const v = render(<SkillEditor />, { wrapper });
	await waitFor(() => expect(v.getByLabelText("Skill name")).toBeEnabled());
	fireEvent.change(v.getByLabelText("Skill name"), {
		target: { value: "Example delivery draft" },
	});
	fireEvent.change(v.getByLabelText("When to use this skill"), {
		target: { value: "Review a delivery report." },
	});
	fireEvent.change(v.getByLabelText("Instructions"), {
		target: { value: "Read the supplied evidence and list risks." },
	});
	fireEvent.click(v.getByRole("button", { name: "Save draft" }));
	await v.findByText("Check whether your draft was saved");
	fireEvent.click(v.getByRole("button", { name: "Check saved drafts" }));
	expect(
		await v.findByRole("link", { name: "Open the existing draft" }),
	).toHaveAttribute("href", `/app/example-org/skills/${skill.id}/edit`);
	expect(
		v.queryByRole("button", {
			name: "I reviewed drafts; allow another attempt",
		}),
	).not.toBeInTheDocument();
	expect(v.getByRole("button", { name: "Save draft" })).toBeDisabled();
	expect(h.create).toHaveBeenCalledTimes(1);
});
it("separates publication from edits and requires explicit confirmation", async () => {
	const v = render(
		<SkillAvailability
			organizationId={context.organizationId}
			skill={skill}
		/>,
		{ wrapper },
	);
	fireEvent.keyDown(v.getByRole("combobox"), { key: "ArrowDown" });
	fireEvent.click(
		await v.findByRole("option", { name: "Organization members" }),
	);
	expect(h.publish).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Update availability" }));
	fireEvent.click(v.getByRole("button", { name: "Confirm availability" }));
	await waitFor(() =>
		expect(h.publish).toHaveBeenCalledWith({
			organizationId: context.organizationId,
			id: skill.id,
			expectedVersion: 2,
			availability: "members",
		}),
	);
	expect(h.update).not.toHaveBeenCalled();
});
it("keeps a shared-skill owner's unpublish control when publication policy is revoked", () => {
	const v = render(
		<SkillAvailability
			organizationId={context.organizationId}
			skill={{
				...skill,
				isPublished: true,
				availability: "members",
				capabilities: {
					...skill.capabilities,
					canEdit: false,
					canPublish: false,
					canDiscover: false,
					canUnpublish: true,
				},
			}}
		/>,
		{ wrapper },
	);
	expect(v.getByRole("combobox")).toBeEnabled();
	expect(v.getByLabelText("Who can find this skill?")).toBeInTheDocument();
});
it("restores archived skills explicitly as drafts without re-publishing", async () => {
	const v = render(
		<SkillViewer
			skill={{
				...skill,
				archivedAt: "2026-01-03T00:00:00Z",
				capabilities: {
					...skill.capabilities,
					canRestore: true,
					canEdit: false,
					canArchive: false,
				},
			}}
		/>,
		{ wrapper },
	);
	fireEvent.click(v.getByRole("button", { name: "Restore as draft" }));
	await waitFor(() =>
		expect(h.restore).toHaveBeenCalledWith({
			organizationId: context.organizationId,
			id: skill.id,
			expectedVersion: 2,
		}),
	);
	expect(h.publish).not.toHaveBeenCalled();
});
it("has labeled authoring controls and accessible conversational panel", async () => {
	const v = render(<SkillEditor mode="conversation" />, { wrapper });
	await v.findByText("What should this skill help your team do?");
	expect(
		(
			await axe(v.getByRole("dialog"), {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});
