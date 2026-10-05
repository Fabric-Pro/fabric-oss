/**
 * `capRejections` (packages/temporal/src/activities/project-instructions.ts)
 * caps a gate's rejection list at 100 and appends a sentinel row
 * (`{ path: "(truncated)", reason: "truncated", detail: "<n> more" }`)
 * instead of an unbounded array. This suite proves `InstructionsRejectedBanner`
 * treats that sentinel as a summary line, not a file: excluded from the
 * title's count and the table, rendered instead as translated copy built
 * from its `detail`.
 *
 * Overrides the shared `next-intl` mock (which only echoes the translation
 * KEY back, per `vitest.setup.ts`) with one that resolves the REAL `en.json`
 * copy — the same technique `components/__tests__/DocumentsList-queued.test.tsx`
 * uses — so the title and summary line can be asserted as real shipped copy.
 */
import type { InstructionRejection } from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

import { InstructionsRejectedBanner } from "../InstructionsRejectedBanner";

describe("InstructionsRejectedBanner", () => {
	it("excludes the truncated sentinel from the count and renders it as a summary line", () => {
		const rejection: InstructionRejection[] = [
			{ path: "a.txt", reason: "hash_mismatch" },
			{ path: "b.txt", reason: "size_mismatch" },
			{ path: "c.txt", reason: "missing" },
			{ path: "(truncated)", reason: "truncated", detail: "42 more" },
		];
		const { container } = render(
			<InstructionsRejectedBanner
				rejection={rejection}
				onUploadAgain={() => undefined}
			/>,
		);
		expect(
			screen.getByRole("heading", {
				name: "Upload rejected: 3 files failed checks",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText("…and 42 more, not shown here."),
		).toBeInTheDocument();
		expect(screen.queryByText("(truncated)")).not.toBeInTheDocument();
		expect(container.querySelectorAll("code")).toHaveLength(3);
	});

	it("sends a repository-backed project back to its repository and offers to sync again", async () => {
		const onSyncAgain = vi.fn();
		render(
			<InstructionsRejectedBanner
				rejection={[{ path: "a.md", reason: "hash_mismatch" }]}
				onUploadAgain={() => undefined}
				mode="repository"
				onSyncAgain={onSyncAgain}
			/>,
		);
		expect(
			screen.getByRole("heading", {
				name: "Sync rejected: 1 file failed checks",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner.bodyRepository,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Upload again" }),
		).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: "Sync again" }),
		);
		expect(onSyncAgain).toHaveBeenCalled();
	});

	// Fizzy #2878 §10: a commit of the branch that the sync refused is named as
	// git names it, so what is wrong is a commit to fix, and Fabric's copy stays
	// at the commit it was.
	it("names the commit the sync refused and the commit Fabric's copy stays at", () => {
		render(
			<InstructionsRejectedBanner
				rejection={[
					{ path: "a.md", reason: "secret", detail: "github-token" },
				]}
				mode="repository"
				commit="b1c2d3e4f5061728394a5b6c7d8e9f0123456789"
				publishedCommit="a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"
				publishedVersion={7}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Commit b1c2d3e refused: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner
					.bodyRepositoryCommit,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Fabric's copy stays at commit a1b2c3d."),
		).toBeInTheDocument();
	});

	it("words several refused files and a sync that never finished, naming the commit", () => {
		const { unmount } = render(
			<InstructionsRejectedBanner
				rejection={[
					{ path: "a.md", reason: "secret", detail: "github-token" },
					{ path: "b.md", reason: "secret", detail: "jwt" },
				]}
				mode="repository"
				commit="b1c2d3e4f5061728394a5b6c7d8e9f0123456789"
			/>,
		);
		expect(
			screen.getByRole("heading", {
				name: "Commit b1c2d3e refused: 2 files contain secrets",
			}),
		).toBeInTheDocument();
		unmount();

		render(
			<InstructionsRejectedBanner
				rejection={[{ path: "(upload)", reason: "abandoned" }]}
				mode="repository"
				commit="b1c2d3e4f5061728394a5b6c7d8e9f0123456789"
			/>,
		);
		expect(
			screen.getByRole("heading", {
				name: "Commit b1c2d3e refused: its sync never finished",
			}),
		).toBeInTheDocument();
	});

	it("keeps the sync wording when the refused version recorded no commit", () => {
		render(
			<InstructionsRejectedBanner
				rejection={[{ path: "a.md", reason: "hash_mismatch" }]}
				mode="repository"
				commit={null}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Sync rejected: 1 file failed checks",
			}),
		).toBeInTheDocument();
	});

	// Fizzy #2878 §10: a direct commit the scan refused was never pushed, so
	// there is no commit to name and nothing to sync or upload again; the way
	// on is to fix the files and commit again.
	it("says a refused commit was never pushed to the branch, and offers neither Upload again nor Sync again", () => {
		const banner = en.projects.codingInstructions.rejectedBanner;
		render(
			<InstructionsRejectedBanner
				rejection={[
					{ path: "a.md", reason: "secret", detail: "github-token" },
				]}
				onUploadAgain={() => undefined}
				onSyncAgain={() => undefined}
				mode="commit"
				branch="main"
				publishedVersion={7}
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Commit not made: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(banner.bodyCommit.replace("{ref}", "main")),
		).toBeInTheDocument();
		expect(
			screen.getByText("Fabric's copy stays at version 7."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Upload again" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Sync again" })).toBeNull();
	});

	it("words a refused commit with several files in the plural", () => {
		render(
			<InstructionsRejectedBanner
				rejection={[
					{ path: "a.md", reason: "secret", detail: "github-token" },
					{ path: "b.md", reason: "secret", detail: "jwt" },
				]}
				mode="commit"
				branch="main"
			/>,
		);

		expect(
			screen.getByRole("heading", {
				name: "Commit not made: 2 files contain secrets",
			}),
		).toBeInTheDocument();
	});

	it("keeps the neutral body for an abandoned upload and still offers Upload again", () => {
		const banner = en.projects.codingInstructions.rejectedBanner;
		const { container } = render(
			<InstructionsRejectedBanner
				rejection={[{ path: "(upload)", reason: "abandoned" }]}
				onUploadAgain={() => undefined}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: banner.titleAbandoned }),
		).toBeInTheDocument();
		expect(screen.getByText(banner.bodyAbandoned)).toBeInTheDocument();
		expect(screen.queryByText(banner.body)).toBeNull();
		expect(container.querySelectorAll("code")).toHaveLength(0);
		expect(
			screen.getByRole("button", { name: "Upload again" }),
		).toBeInTheDocument();
	});

	it("still asks for files to be fixed when an abandoned row sits beside a real finding", () => {
		const banner = en.projects.codingInstructions.rejectedBanner;
		render(
			<InstructionsRejectedBanner
				rejection={[
					{ path: "(upload)", reason: "abandoned" },
					{ path: "a.md", reason: "missing" },
				]}
				onUploadAgain={() => undefined}
			/>,
		);
		expect(screen.getByText(banner.body)).toBeInTheDocument();
		expect(screen.getByText("a.md")).toBeInTheDocument();
	});
});
