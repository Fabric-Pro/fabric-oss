/**
 * `InstructionsTree` renders every string through `useTranslations`, so this
 * suite overrides the shared `next-intl` mock (which only echoes the
 * translation KEY back, per `vitest.setup.ts`) with one that resolves the
 * REAL `en.json` copy — the same technique
 * `components/__tests__/DocumentsList-queued.test.tsx` uses — so the search
 * box's accessible name can be asserted against actual shipped copy rather
 * than a key.
 */
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
	NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
		children,
}));

import { InstructionsTree } from "../InstructionsTree";

const files = [
	{
		id: "1",
		path: ".claude/skills/example-qa-test/SKILL.md",
		kind: "SKILL",
		name: "example-qa-test",
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
	{
		id: "2",
		path: ".claude/agents/qa-lead.md",
		kind: "AGENT",
		name: "qa-lead",
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
	{
		id: "3",
		path: "CLAUDE.md",
		kind: "INSTRUCTIONS",
		name: null,
		description: null,
		size: 10,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	},
] as const;

describe("InstructionsTree", () => {
	it("renders folders collapsed with counts and opens a file on click", async () => {
		const onSelect = vi.fn();
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={onSelect}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /\.claude 2/ }),
		).toBeInTheDocument();
		expect(screen.queryByText("SKILL.md")).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /\.claude 2/ }),
		);
		await userEvent.click(screen.getByRole("button", { name: /skills 1/ }));
		await userEvent.click(
			screen.getByRole("button", { name: /example-qa-test 1/ }),
		);
		await userEvent.click(screen.getByRole("button", { name: "SKILL.md" }));
		expect(onSelect).toHaveBeenCalledWith(
			".claude/skills/example-qa-test/SKILL.md",
		);
	});

	it("filters by the search box across path, name and description", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"qa-lead",
		);
		expect(
			screen.getByRole("button", { name: "qa-lead.md" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});

	// The chip group is a real <fieldset> named by a visually-hidden
	// <legend>, matching `qa-settings/QaCiSetupSection.tsx`. Asserted through
	// the accessible `group` role so the name has to come from a real naming
	// mechanism, not from text that merely sits nearby.
	it("names the kind filter as a group", () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		expect(
			screen.getByRole("group", { name: "Filter by kind" }),
		).toBeInTheDocument();
	});

	it("filters by kind, hiding files of other kinds", async () => {
		render(
			<InstructionsTree
				files={[...files]}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Skill" }));
		expect(
			screen.getByRole("button", { name: "SKILL.md" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "qa-lead.md" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});

	// The two filters must AND, not replace each other: `kindFilter` narrows
	// first and the query narrows within that result. Each was covered alone,
	// so a change making one clobber the other would have passed both.
	it("composes the kind filter with the search box", async () => {
		const twoSkills = [
			...files,
			{
				id: "4",
				path: ".claude/skills/example-release-notes/SKILL.md",
				kind: "SKILL" as const,
				name: "example-release-notes",
				description: null,
				size: 10,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
			},
		];
		render(
			<InstructionsTree
				files={twoSkills}
				selectedPath={null}
				onSelect={() => undefined}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Skill" }));
		// Both SKILL rows survive the kind filter; they share a file name, so
		// the surviving leaf is identified by its parent folder.
		expect(
			screen.getByRole("button", { name: /example-qa-test 1/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /example-release-notes 1/ }),
		).toBeInTheDocument();

		await userEvent.type(
			screen.getByRole("searchbox", { name: "Search files" }),
			"release-notes",
		);
		// The query narrows WITHIN the kind, rather than reinstating the
		// AGENT/INSTRUCTIONS files the kind filter removed.
		expect(
			screen.getByRole("button", { name: /example-release-notes 1/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /example-qa-test/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "qa-lead.md" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "CLAUDE.md" }),
		).not.toBeInTheDocument();
	});
});
