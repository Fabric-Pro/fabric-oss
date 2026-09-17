/**
 * `InstructionFileView` routes all chrome copy through `useTranslations`, so
 * this suite overrides the shared `next-intl` mock (which only echoes the
 * translation KEY back, per `vitest.setup.ts`) with one that resolves the
 * REAL `en.json` copy — the same technique
 * `components/__tests__/DocumentsList-queued.test.tsx` uses. This is what
 * lets "Disabled, runs only when a person calls it" (the model-invocation
 * label) be asserted as real shipped copy.
 *
 * The header renders the file's CLASSIFIED `name`/`description` fields
 * (not a re-parse of the frontmatter block) — see the component's own doc
 * comment. The fixture below deliberately omits a `description:` frontmatter
 * key so this suite proves that: the frontmatter block only carries `name`,
 * `effort`, `allowed-tools`, and `disable-model-invocation`, yet the
 * description still renders from the mocked file row.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

// The row the mocked `getFile` returns. Mutable so each test can swap in the
// shape it needs (a binary row, a truncated text row) without a second mock
// factory — `vi.mock` is hoisted, so the factory closes over this binding
// rather than a value.
const fileResponse = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

const TEXT_FILE = {
	path: ".claude/skills/example-qa-test/SKILL.md",
	kind: "SKILL",
	name: "example-qa-test",
	description: "Use when the user provides a work item ID.",
	size: 31000,
	mimeType: "text/markdown",
	isText: true,
	mode: null,
	body: "---\nname: example-qa-test\neffort: max\nallowed-tools: Read, Glob\ndisable-model-invocation: true\n---\n\n# Example QA Test Workflow\nBody.",
	offset: 0,
	nextOffset: null,
	truncated: false,
	url: null,
};

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getFile: {
					queryOptions: (o: unknown) => ({
						queryKey: ["getFile", o],
						queryFn: async () => fileResponse.current,
					}),
				},
			},
		},
	},
}));

import { InstructionFileView } from "../InstructionFileView";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("InstructionFileView", () => {
	beforeEach(() => {
		fileResponse.current = { ...TEXT_FILE };
	});

	it("renders frontmatter as a header and the body without the frontmatter block", async () => {
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByRole("heading", { name: "example-qa-test" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Use when the user provides a work item ID."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Disabled, runs only when a person calls it"),
		).toBeInTheDocument();
		expect(screen.getByText("Read, Glob")).toBeInTheDocument();
		expect(screen.queryByText(/^---$/)).not.toBeInTheDocument();
	});

	// Task 14 finding 4: the two branches the server can return besides a
	// whole text body had no coverage at all, including the download link
	// that round added `target`/`rel` to.
	it("renders a binary file as a download link instead of a body", async () => {
		fileResponse.current = {
			...TEXT_FILE,
			path: "assets/logo.png",
			kind: "OTHER",
			name: null,
			description: null,
			mimeType: "image/png",
			isText: false,
			body: null,
			url: "https://storage.example.com/signed/logo.png",
		};
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path="assets/logo.png"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByText("This is a binary file.", { exact: false }),
		).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Download it" });
		expect(link).toHaveAttribute(
			"href",
			"https://storage.example.com/signed/logo.png",
		);
		// A signed storage URL opens in a new tab, and `rel` keeps that tab
		// from reaching back through `window.opener`.
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("tells the reader the body is cut short when the server truncated it", async () => {
		fileResponse.current = {
			...TEXT_FILE,
			path: "docs/big.md",
			kind: "KNOWLEDGE",
			name: null,
			description: null,
			body: "# Long document\nFirst page only.",
			truncated: true,
			nextOffset: 200_000,
		};
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path="docs/big.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByText(
				"Showing the first 200000 characters. Download the snapshot for the full file.",
			),
		).toBeInTheDocument();
	});

	it("shows no truncation note for a complete body", async () => {
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		await screen.findByRole("heading", { name: "example-qa-test" });
		expect(
			screen.queryByText(/Download the snapshot for the full file/),
		).not.toBeInTheDocument();
	});
});
