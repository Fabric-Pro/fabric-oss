import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { skill } from "./fixtures";

const h = vi.hoisted(() => ({ remove: vi.fn(), get: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { skills: { delete: h.remove, get: h.get } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

import { SkillDeleteAction } from "../SkillDeleteAction";

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
	h.remove.mockResolvedValue({ success: true });
	h.get.mockResolvedValue({ skill });
});
async function open(v: ReturnType<typeof render>) {
	fireEvent.keyDown(v.getByRole("button", { name: "Skill actions" }), {
		key: "Enter",
	});
	fireEvent.click(
		await v.findByRole("menuitem", { name: "Delete permanently" }),
	);
	return v.findByRole("alertdialog");
}
it("hides permanent deletion without current capability and disables it for an unsaved editor", () => {
	const v = render(
		<SkillDeleteAction
			skill={{
				...skill,
				capabilities: { ...skill.capabilities, canDelete: false },
			}}
			organizationId="example-org"
			onDeleted={vi.fn()}
		/>,
		{ wrapper },
	);
	expect(
		v.queryByRole("button", { name: "Skill actions" }),
	).not.toBeInTheDocument();
	v.rerender(
		<SkillDeleteAction
			skill={skill}
			organizationId="example-org"
			onDeleted={vi.fn()}
			disabled
		/>,
	);
	expect(v.getByRole("button", { name: "Skill actions" })).toBeDisabled();
	expect(h.remove).not.toHaveBeenCalled();
});
it("requires the exact skill name, then deletes only the explicitly reviewed saved version", async () => {
	const onDeleted = vi.fn();
	const v = render(
		<SkillDeleteAction
			skill={skill}
			organizationId="example-org"
			onDeleted={onDeleted}
		/>,
		{ wrapper },
	);
	await open(v);
	expect(h.remove).not.toHaveBeenCalled();
	fireEvent.change(v.getByLabelText("Type the skill name to confirm"), {
		target: { value: skill.name.toLowerCase() },
	});
	expect(
		v.getByRole("button", { name: "Delete permanently", exact: true }),
	).toBeDisabled();
	fireEvent.change(v.getByLabelText("Type the skill name to confirm"), {
		target: { value: skill.name },
	});
	fireEvent.click(
		v.getByRole("button", { name: "Delete permanently", exact: true }),
	);
	await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
	expect(h.remove).toHaveBeenCalledExactlyOnceWith({
		organizationId: "example-org",
		id: skill.id,
		expectedVersion: skill.version,
	});
});
it("does not silently retarget a confirmation after the skill version changed", async () => {
	const props = { organizationId: "example-org", onDeleted: vi.fn() };
	const v = render(<SkillDeleteAction skill={skill} {...props} />, {
		wrapper,
	});
	await open(v);
	fireEvent.change(v.getByLabelText("Type the skill name to confirm"), {
		target: { value: skill.name },
	});
	v.rerender(
		<SkillDeleteAction skill={{ ...skill, version: 3 }} {...props} />,
	);
	expect(v.getByText(/This skill changed/)).toBeInTheDocument();
	expect(
		v.getByRole("button", { name: "Delete permanently", exact: true }),
	).toBeDisabled();
	expect(h.remove).not.toHaveBeenCalled();
});
it("retains uncertainty across closing/reopening and only permits another reviewed attempt after a real authorized refresh", async () => {
	h.remove.mockRejectedValueOnce(new Error("Response unavailable"));
	const v = render(
		<SkillDeleteAction
			skill={skill}
			organizationId="example-org"
			onDeleted={vi.fn()}
		/>,
		{ wrapper },
	);
	await open(v);
	fireEvent.change(v.getByLabelText("Type the skill name to confirm"), {
		target: { value: skill.name },
	});
	fireEvent.click(
		v.getByRole("button", { name: "Delete permanently", exact: true }),
	);
	await v.findByText(/This skill may already have been deleted/);
	expect(h.remove).toHaveBeenCalledTimes(1);
	fireEvent.click(v.getByRole("button", { name: "Cancel", exact: true }));
	await open(v);
	fireEvent.change(v.getByLabelText("Type the skill name to confirm"), {
		target: { value: skill.name },
	});
	expect(
		v.getByRole("button", { name: "Delete permanently", exact: true }),
	).toBeDisabled();
	fireEvent.click(
		v.getByRole("button", { name: "Refresh skill", exact: true }),
	);
	await waitFor(() =>
		expect(h.get).toHaveBeenCalledExactlyOnceWith({
			id: skill.id,
			organizationId: "example-org",
		}),
	);
	await waitFor(() =>
		expect(
			v.queryByText(/This skill may already have been deleted/),
		).not.toBeInTheDocument(),
	);
	expect(v.getByLabelText("Type the skill name to confirm")).toHaveValue("");
	expect(h.remove).toHaveBeenCalledTimes(1);
});
