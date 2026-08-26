import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import NewsletterApprovalPending from "./NewsletterApprovalPending";

const base = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Example Project",
	url: "https://example.com/app/example-org/projects/p1?tab=settings&settingsTab=newsletter",
};

describe("NewsletterApprovalPending", () => {
	it("renders the project name and links to the review screen", async () => {
		const html = await render(NewsletterApprovalPending(base as never));

		expect(html).toContain("Example Project");
		expect(html).toContain(
			"https://example.com/app/example-org/projects/p1",
		);
	});

	it("passes the URL through untouched, query string and all", async () => {
		// The activity owns the tenant-correct URL; the template must not
		// rebuild or trim it, or the deep link stops landing on the review tab.
		const html = await render(NewsletterApprovalPending(base as never));

		expect(html).toContain("settingsTab=newsletter");
	});

	it("does not assert the draft is still pending", async () => {
		// A decision can land between the send and the click. The review screen
		// reports an already-decided review neutrally, so the copy must not
		// claim something the reader may find untrue on arrival.
		const html = await render(NewsletterApprovalPending(base as never));

		expect(html).not.toMatch(/is waiting for you|still awaiting/i);
	});

	it("resolves a subject carrying the project name", () => {
		const subject = NewsletterApprovalPending.resolveSubject(
			{ projectName: "Example Project" },
			((key: string, values?: Record<string, unknown>) =>
				`${key}:${values?.projectName}`) as never,
		);

		expect(subject).toContain("Example Project");
	});
});
