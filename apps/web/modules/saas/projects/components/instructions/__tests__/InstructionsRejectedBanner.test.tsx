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
});
