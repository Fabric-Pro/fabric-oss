import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { defaultLocale, defaultTranslations } from "../src/util/translations";
import ReleaseNotesNewsletter from "./ReleaseNotesNewsletter";

const base = {
	locale: defaultLocale,
	translations: defaultTranslations,
	projectName: "Acme",
	headline: "June update",
	intro: "Stuff shipped.",
	unsubscribeUrl: "https://app/unsub",
	appUrl: "https://app",
	highlights: [
		{
			title: "A",
			description: "d",
			prUrl: "https://github.com/acme/web/releases/tag/v1.3.4",
			releaseTag: "v1.3.4",
			repoFullName: "acme/web",
		},
		{
			title: "B",
			description: "d",
			prUrl: "https://github.com/acme/web/releases/tag/v1.3.7",
			releaseTag: "v1.3.7",
			repoFullName: "acme/web",
		},
	],
};

describe("ReleaseNotesNewsletter", () => {
	it("renders headline, highlights, and the unsubscribe link", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).toContain("June update");
		expect(html).toContain("https://app/unsub");
	});

	it("renders version badges newest-first and no raw release links", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).toContain("v1.3.7");
		expect(html).toContain("v1.3.4");
		expect(html.indexOf("v1.3.7")).toBeLessThan(html.indexOf("v1.3.4"));
		// No per-release link to the GitHub release URL.
		expect(html).not.toContain("releases/tag/v1.3.7");
	});

	it("renders version pills as a filled neutral chip (visible bg + dark text)", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		// react-email inlines theme colors as rgb(). The old `bg-surface`/
		// `text-primary` pill was visually invisible (surface ≈ card) with red
		// text; the `chip` token gives a visible grey badge with dark stone text
		// (#e7e5e4 bg / #57534e fg), matching the design mockup. Match the
		// channels with a separator-tolerant regex so a serializer change
		// (`rgb(231, 229, 228)` / `rgb(231 229 228)`) doesn't flake the test.
		expect(html).toMatch(/rgb\(\s*231[,\s]+229[,\s]+228\s*\)/); // chip bg
		expect(html).toMatch(/rgb\(\s*87[,\s]+83[,\s]+78\s*\)/); // chip fg
	});

	it("scopes the unsubscribe notice to the project name", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).toContain("subscribed to Acme updates");
		expect(html).not.toContain("subscribed to product updates");
	});

	it("renders the Open Fabric CTA with a trailing arrow", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).toContain("Open Fabric →");
	});

	it("renders the Open Fabric CTA when appUrl is set and omits it otherwise", async () => {
		const withCta = await render(ReleaseNotesNewsletter(base as any));
		expect(withCta).toContain("https://app");
		const noCta = await render(
			ReleaseNotesNewsletter({ ...base, appUrl: undefined } as any),
		);
		expect(noCta).not.toContain(">Open Fabric<");
	});

	it("renders localized Privacy + Terms footer links built from appUrl + locale", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).toContain(
			`https://app/${defaultLocale}/legal/privacy-policy`,
		);
		expect(html).toContain(`https://app/${defaultLocale}/legal/terms`);
		expect(html).toContain("Privacy Policy");
		expect(html).toContain("Terms");
	});

	it("renders a highlight's images full width with their alt text", async () => {
		const html = await render(
			ReleaseNotesNewsletter({
				...base,
				highlights: [
					{
						...base.highlights[0],
						images: [
							{
								url: "https://app/image-proxy/b/newsletter-public/one.png",
								alt: "The new export menu",
							},
						],
					},
					base.highlights[1],
				],
			} as any),
		);
		expect(html).toMatch(
			/<img[^>]*alt="The new export menu"[^>]*src="https:\/\/app\/image-proxy\/b\/newsletter-public\/one\.png"/,
		);
		expect(html).toMatch(
			/<img[^>]*src="https:\/\/app\/image-proxy[^"]*"[^>]*width="456"/,
		);
	});

	it("renders an image placed above before the description and the rest after", async () => {
		const html = await render(
			ReleaseNotesNewsletter({
				...base,
				highlights: [
					{
						...base.highlights[0],
						description: "Exports now include filters.",
						images: [
							{ url: "https://app/below.png", alt: "Below" },
							{
								url: "https://app/above.png",
								alt: "Above",
								placement: "ABOVE",
							},
						],
					},
				],
			} as any),
		);
		// React also writes each image URL into an early preload hint, so the
		// rendered image is the URL's last occurrence.
		const description = html.indexOf("Exports now include filters.");
		const above = html.lastIndexOf("https://app/above.png");
		const below = html.lastIndexOf("https://app/below.png");
		expect(description).toBeGreaterThan(-1);
		expect(above).toBeGreaterThan(-1);
		expect(above).toBeLessThan(description);
		expect(below).toBeGreaterThan(description);
	});

	it("renders no image for a highlight without images", async () => {
		const html = await render(ReleaseNotesNewsletter(base as any));
		expect(html).not.toContain("image-proxy");
		// The logo is the only image in a text-only issue.
		expect(html.match(/<img/g)).toHaveLength(1);
	});

	it("omits legal links when appUrl is absent", async () => {
		const html = await render(
			ReleaseNotesNewsletter({ ...base, appUrl: undefined } as any),
		);
		expect(html).not.toContain("/legal/privacy-policy");
	});

	it("normalizes a trailing slash on appUrl (no double slash in legal URLs)", async () => {
		const html = await render(
			ReleaseNotesNewsletter({ ...base, appUrl: "https://app/" } as any),
		);
		expect(html).toContain(
			`https://app/${defaultLocale}/legal/privacy-policy`,
		);
		expect(html).not.toContain("https://app//");
	});
});
