import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { context, skill } from "./fixtures";

const h = vi.hoisted(() => ({
	preview: vi.fn(),
	create: vi.fn(),
	read: vi.fn(),
	push: vi.fn(),
	list: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
	}),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		skills: {
			import: { preview: h.preview, create: h.create, readFile: h.read },
			list: h.list,
		},
	},
}));

import { SkillImportDialog } from "../SkillImportDialog";

const content = "# Example\nFollow the process and cite evidence.";
const preview = {
	source: {
		kind: "github",
		sha256: "a".repeat(64),
		repository: "example/skills",
		commit: "b".repeat(40),
	},
	candidates: [
		{
			key: "skills/example/SKILL.md",
			draft: {
				name: skill.name,
				slug: skill.slug,
				description: skill.description,
				content,
				tags: [],
			},
			files: [
				{
					path: "references/example.html",
					contentType: "text/html",
					sizeBytes: 40,
					sha256: "c".repeat(64),
				},
			],
			warnings: ["Review imported instructions before using them."],
		},
	],
	warnings: [],
};
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
const props = {
	organizationId: context.organizationId,
	basePath: context.basePath,
	onClose: () => undefined,
};
beforeEach(() => {
	vi.clearAllMocks();
	h.preview.mockResolvedValue(preview);
	h.create.mockResolvedValue({ skill });
	h.list.mockResolvedValue({
		skills: [],
		total: 0,
		hasMore: false,
		nextCursor: null,
	});
	h.read.mockResolvedValue({
		path: "references/example.html",
		contentType: "text/html",
		sizeBytes: 40,
		sha256: "c".repeat(64),
		encoding: "utf-8",
		data: "<script>window.exampleExecuted=true</script>",
	});
});
async function repository(v: ReturnType<typeof render>) {
	fireEvent.mouseDown(v.getByRole("tab", { name: "GitHub repository" }), {
		button: 0,
		ctrlKey: false,
	});
	fireEvent.change(v.getByLabelText("Public GitHub repository URL"), {
		target: { value: "https://github.com/example/skills" },
	});
	fireEvent.click(v.getByRole("button", { name: "Preview skills" }));
	await v.findByLabelText("Draft name");
}
it("does not repeat an unconfirmed import after metadata changes until saved drafts are reviewed", async () => {
	h.create.mockRejectedValueOnce(new Error("Import response unavailable"));
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	await repository(v);
	fireEvent.click(v.getByRole("button", { name: "Create draft" }));
	await v.findByText("Check whether your draft was saved");
	fireEvent.change(v.getByLabelText("Draft name"), {
		target: { value: "A different draft" },
	});
	expect(v.getByRole("button", { name: "Create draft" })).toBeDisabled();
	expect(h.create).toHaveBeenCalledTimes(1);
	expect(h.list).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Check saved drafts" }));
	fireEvent.click(
		await v.findByRole("button", {
			name: "I reviewed drafts; allow another attempt",
		}),
	);
	expect(v.getByRole("button", { name: "Create draft" })).toBeEnabled();
	expect(h.create).toHaveBeenCalledTimes(1);
});
it("does not create anything on open or preview and pins the exact reviewed source on explicit Create", async () => {
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	expect(h.preview).not.toHaveBeenCalled();
	expect(h.create).not.toHaveBeenCalled();
	await repository(v);
	expect(v.getByText(/Reviewed commit:/)).toHaveTextContent(
		preview.source.commit,
	);
	expect(
		v.getByText("Review imported instructions before using them."),
	).toBeInTheDocument();
	expect(h.create).not.toHaveBeenCalled();
	fireEvent.click(v.getByRole("button", { name: "Create draft" }));
	await waitFor(() =>
		expect(h.create).toHaveBeenCalledWith({
			organizationId: context.organizationId,
			source: {
				kind: "github",
				url: "https://github.com/example/skills",
				ref: preview.source.commit,
			},
			candidateKey: preview.candidates[0].key,
			expectedHash: preview.source.sha256,
			overrides: {
				name: skill.name,
				slug: skill.slug,
				description: skill.description,
			},
		}),
	);
	expect(h.push).toHaveBeenCalledWith(
		`/app/example-org/skills/${skill.id}/edit`,
	);
});
it("clears the reviewed preview whenever its source changes", async () => {
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	await repository(v);
	fireEvent.change(v.getByLabelText("Public GitHub repository URL"), {
		target: { value: "https://github.com/example/other" },
	});
	expect(v.queryByLabelText("Draft name")).not.toBeInTheDocument();
	expect(v.getByRole("button", { name: "Create draft" })).toBeDisabled();
	expect(h.create).not.toHaveBeenCalled();
});
it("requires a confirmed reviewed commit instead of importing moving repository HEAD", async () => {
	h.preview.mockResolvedValue({
		...preview,
		source: { ...preview.source, commit: undefined },
	});
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	await repository(v);
	expect(v.getByRole("button", { name: "Create draft" })).toBeDisabled();
	expect(v.getByText(/revision could not be confirmed/)).toBeInTheDocument();
});
it("reads runtime files through the source hash and renders HTML as escaped text", async () => {
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	await repository(v);
	fireEvent.click(v.getByRole("button", { name: "references/example.html" }));
	const fileDialog = await v.findByRole("dialog", {
		name: "references/example.html",
	});
	expect(
		await within(fileDialog).findByText(
			"<script>window.exampleExecuted=true</script>",
		),
	).toBeInTheDocument();
	expect(fileDialog.querySelector("script")).toBeNull();
	expect(fileDialog.querySelector("iframe")).toBeNull();
	expect(h.read).toHaveBeenCalledWith({
		organizationId: context.organizationId,
		source: {
			kind: "github",
			url: "https://github.com/example/skills",
			ref: preview.source.commit,
		},
		candidateKey: preview.candidates[0].key,
		expectedHash: preview.source.sha256,
		path: "references/example.html",
	});
	expect(h.create).not.toHaveBeenCalled();
});
it("supports Markdown file input and refuses oversized uploads before a request", async () => {
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	const tooBig = new File(["x"], "example.zip");
	Object.defineProperty(tooBig, "size", { value: 8 * 1024 * 1024 + 1 });
	fireEvent.change(v.getByLabelText("Skill file"), {
		target: { files: [tooBig] },
	});
	expect(v.getByText("Choose a file under 8 MiB.")).toBeInTheDocument();
	expect(h.preview).not.toHaveBeenCalled();
	h.preview.mockResolvedValue({
		...preview,
		source: { kind: "file", fileName: "SKILL.md", sha256: "a".repeat(64) },
	});
	fireEvent.change(v.getByLabelText("Skill file"), {
		target: {
			files: [
				new File(
					[
						"---\nname: Example\ndescription: Example skill\n---\nInstructions",
					],
					"SKILL.md",
				),
			],
		},
	});
	await waitFor(() =>
		expect(v.getByRole("button", { name: "Preview skills" })).toBeEnabled(),
	);
	fireEvent.click(v.getByRole("button", { name: "Preview skills" }));
	await v.findByLabelText("Draft name");
	expect(h.preview).toHaveBeenCalledWith({
		organizationId: context.organizationId,
		source: {
			kind: "file",
			fileName: "SKILL.md",
			base64: expect.any(String),
		},
	});
	expect(h.create).not.toHaveBeenCalled();
});
it("provides accessible import source labels and review controls", async () => {
	const v = render(<SkillImportDialog {...props} />, { wrapper });
	expect(
		(
			await axe(v.getByRole("dialog"), {
				rules: { "color-contrast": { enabled: false } },
			})
		).violations,
	).toEqual([]);
});
