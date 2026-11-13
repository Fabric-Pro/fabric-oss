/**
 * The placeholder data a release-notes screenshot gets: email addresses,
 * phone numbers and the sign-in name become placeholders; ordinary text and
 * numbers stay.
 */
import { describe, expect, it } from "vitest";
import {
	hideOverlaysScript,
	MASK_EMAIL,
	MASK_NAME,
	MASK_PHONE,
	maskPageScript,
	maskText,
	signInMaskTerms,
} from "./screenshot-masking";

interface FakeRoot {
	textNodes: Array<{ nodeValue: string }>;
	querySelectorAll(selector: string): unknown[];
}

/** A document or shadow root: its text nodes, elements, fields and images. */
function fakeRoot(parts: {
	textNodes?: Array<{ nodeValue: string }>;
	elements?: unknown[];
	fields?: unknown[];
	images?: unknown[];
}): FakeRoot {
	return {
		textNodes: parts.textNodes ?? [],
		querySelectorAll: (selector: string) => {
			switch (selector) {
				case "*":
					return parts.elements ?? [];
				case "img":
					return parts.images ?? [];
				case "input, textarea":
					return parts.fields ?? [];
				default:
					return [];
			}
		},
	};
}

interface FakeComputedStyle {
	position: string;
	backgroundImage: string;
	borderRadius: string;
	borderTopLeftRadius: string;
}

/** An element as the script reads it: computed style, box, text, controls. */
function fakeElement(over: {
	position?: string;
	backgroundImage?: string;
	borderRadius?: string;
	className?: string;
	ariaLabel?: string;
	width?: number;
	height?: number;
	top?: number;
	tagName?: string;
	textContent?: string;
	choices?: string[];
	shadowRoot?: FakeRoot;
}) {
	const computed: FakeComputedStyle = {
		position: over.position ?? "static",
		backgroundImage: over.backgroundImage ?? "none",
		borderRadius: over.borderRadius ?? "0px",
		borderTopLeftRadius: over.borderRadius ?? "0px",
	};
	return {
		computed,
		className: over.className ?? "",
		tagName: over.tagName ?? "DIV",
		textContent: over.textContent ?? "",
		shadowRoot: over.shadowRoot ?? null,
		style: { visibility: "", backgroundImage: "" },
		getAttribute: (name: string) =>
			name === "aria-label" ? (over.ariaLabel ?? null) : null,
		getBoundingClientRect: () => ({
			width: over.width ?? 0,
			height: over.height ?? 0,
			top: over.top ?? 0,
		}),
		querySelectorAll: () =>
			(over.choices ?? []).map((text) => ({ textContent: text })),
	};
}

/** A background image drawn at `width` x `height`, with any extras. */
function backgroundElement(
	width: number,
	height: number,
	over: Parameters<typeof fakeElement>[0] = {},
) {
	return fakeElement({
		backgroundImage: 'url("https://example.com/picture.png")',
		width,
		height,
		...over,
	});
}

function fakeField(initial: string, placeholder: string) {
	return {
		type: "text",
		value: initial,
		attributes: new Map([["placeholder", placeholder]]),
		getAttribute(name: string) {
			return this.attributes.get(name) ?? null;
		},
		setAttribute(name: string, value: string) {
			this.attributes.set(name, value);
		},
	};
}

function fakeImage(alt: string, width: number, height: number) {
	return {
		alt,
		className: "",
		src: `https://example.com/${width}.png`,
		width,
		height,
		style: { visibility: "" },
	};
}

/** The few DOM members the script touches, as plain objects. */
function fakePage() {
	const textNodes = [
		{ nodeValue: "Contact someone.real@company.example.org" },
		{ nodeValue: "Release v2.14.3" },
	];
	const field = fakeField("+44 20 7946 0958", "you@company.example.org");
	const avatar = fakeImage("Avatar", 32, 32);
	const chart = fakeImage("Usage chart", 800, 400);
	const banner = fakeElement({
		position: "fixed",
		textContent: "Your privacy. We use analytics cookies. Allow / Decline",
		choices: ["Allow", "Decline"],
	});
	const consentMenuItem = fakeElement({
		position: "sticky",
		textContent: "Consent",
		choices: ["Consent"],
	});
	const toolbar = fakeElement({
		position: "sticky",
		textContent: "Search docs",
	});
	const article = fakeElement({
		textContent: "Cookie settings are described below.",
		choices: ["Accept"],
	});
	const cssAvatar = backgroundElement(40, 40, { borderRadius: "50%" });
	const pxRoundAvatar = backgroundElement(32, 32, { borderRadius: "16px" });
	const namedAvatar = backgroundElement(40, 40, {
		className: "member-badge",
	});
	const labelledAvatar = backgroundElement(36, 36, {
		ariaLabel: "Person card",
	});
	const logo = backgroundElement(40, 40, { borderRadius: "4px" });
	const tinyIcon = backgroundElement(12, 12, { borderRadius: "50%" });
	const wideRoundLogo = backgroundElement(90, 40, { borderRadius: "50%" });
	const hero = backgroundElement(1200, 400, {
		className: "user-hero",
		borderRadius: "50%",
	});
	const launcher = fakeElement({
		position: "fixed",
		tagName: "BUTTON",
		width: 44,
		height: 44,
		top: 668,
	});
	const headerButton = fakeElement({
		position: "fixed",
		tagName: "BUTTON",
		width: 44,
		height: 44,
		top: 12,
	});
	const bottomBar = fakeElement({
		position: "fixed",
		width: 1024,
		height: 56,
		top: 744,
		choices: ["Save"],
	});
	const shadowText = { nodeValue: "Owner: someone.real@company.example.org" };
	const shadowField = fakeField("(212) 555-0147", "");
	const shadowAvatar = fakeImage("Profile photo", 200, 200);
	const widget = fakeElement({
		shadowRoot: fakeRoot({
			textNodes: [shadowText],
			fields: [shadowField],
			images: [shadowAvatar],
		}),
	});
	const body = { textNodes };
	const document = {
		...fakeRoot({
			textNodes,
			elements: [
				banner,
				consentMenuItem,
				toolbar,
				article,
				cssAvatar,
				pxRoundAvatar,
				namedAvatar,
				labelledAvatar,
				logo,
				tinyIcon,
				wideRoundLogo,
				hero,
				launcher,
				headerButton,
				bottomBar,
				widget,
			],
			fields: [field],
			images: [avatar, chart],
		}),
		body,
		documentElement: { clientHeight: 800 },
		createTreeWalker: (target: Pick<FakeRoot, "textNodes">) => {
			let index = 0;
			return { nextNode: () => target.textNodes[index++] ?? null };
		},
	};
	const getComputedStyle = (element: { computed: FakeComputedStyle }) =>
		element.computed;
	return {
		document,
		getComputedStyle,
		textNodes,
		field,
		avatar,
		chart,
		banner,
		consentMenuItem,
		toolbar,
		article,
		cssAvatar,
		pxRoundAvatar,
		namedAvatar,
		labelledAvatar,
		logo,
		tinyIcon,
		wideRoundLogo,
		hero,
		launcher,
		headerButton,
		bottomBar,
		shadowText,
		shadowField,
		shadowAvatar,
	};
}

function runScript(
	page: ReturnType<typeof fakePage>,
	extraTerms: string[] = [],
) {
	new Function(
		"document",
		"NodeFilter",
		"getComputedStyle",
		maskPageScript(extraTerms),
	)(page.document, { SHOW_TEXT: 4 }, page.getComputedStyle);
}

describe("maskText", () => {
	it("replaces email addresses", () => {
		expect(maskText("Owner: someone.real@company.example.org")).toBe(
			`Owner: ${MASK_EMAIL}`,
		);
	});

	it("replaces phone numbers in common shapes", () => {
		expect(maskText("Call +44 20 7946 0958 today")).toBe(
			`Call ${MASK_PHONE} today`,
		);
		expect(maskText("Phone: (212) 555-0147")).toBe(`Phone: ${MASK_PHONE}`);
	});

	it("leaves versions, dates and counts alone", () => {
		const text = "v2.14.3 shipped on 2026-11-11 with 1200 fixes";
		expect(maskText(text)).toBe(text);
	});

	it("replaces extra terms as whole words, ignoring case", () => {
		expect(
			maskText("Signed in as QA.Viewer (qa.viewer+1)", ["qa.viewer"]),
		).toBe(`Signed in as ${MASK_NAME} (${MASK_NAME}+1)`);
		expect(maskText("Aqa.viewers stay", ["qa.viewer"])).toBe(
			"Aqa.viewers stay",
		);
	});

	it("matches a term with RegExp characters literally", () => {
		expect(maskText("Owner: a+b (x) a+bb", ["a+b (x)"])).toBe(
			`Owner: ${MASK_NAME} a+bb`,
		);
	});
});

describe("signInMaskTerms", () => {
	it("names an email username and its local part", () => {
		expect(signInMaskTerms("qa.viewer@example.com")).toEqual([
			"qa.viewer@example.com",
			"qa.viewer",
		]);
	});

	it("names a plain username, and nothing when there is none", () => {
		expect(signInMaskTerms(" demo-user ")).toEqual(["demo-user"]);
		expect(signInMaskTerms(null)).toEqual([]);
		expect(signInMaskTerms("")).toEqual([]);
	});
});

describe("maskPageScript", () => {
	it("is self-contained source, free of bundler helpers", () => {
		expect(maskPageScript([])).not.toContain("__name");
		expect(maskPageScript(["demo-user"])).not.toContain("__name");
		expect(hideOverlaysScript()).not.toContain("__name");
	});

	it("replaces the sign-in name on the page", () => {
		const page = fakePage();
		page.textNodes[1].nodeValue = "Release v2.14.3 by Demo-User";
		page.field.value = "demo-user";
		runScript(page, ["demo-user"]);

		expect(page.textNodes[1].nodeValue).toBe(
			`Release v2.14.3 by ${MASK_NAME}`,
		);
		expect(page.field.value).toBe(MASK_NAME);
	});

	it("masks text, form values and placeholders, and hides avatars", () => {
		const page = fakePage();
		runScript(page);

		expect(page.textNodes[0].nodeValue).toBe(`Contact ${MASK_EMAIL}`);
		expect(page.textNodes[1].nodeValue).toBe("Release v2.14.3");
		expect(page.field.value).toBe(MASK_PHONE);
		expect(page.field.getAttribute("placeholder")).toBe(MASK_EMAIL);
		expect(page.avatar.style.visibility).toBe("hidden");
		expect(page.chart.style.visibility).toBe("");
	});

	it("hides a floating consent banner that offers a choice, and nothing else", () => {
		const page = fakePage();
		runScript(page);

		expect(page.banner.style.visibility).toBe("hidden");
		expect(page.consentMenuItem.style.visibility).toBe("");
		expect(page.toolbar.style.visibility).toBe("");
		expect(page.article.style.visibility).toBe("");
	});

	it("hides a small fixed launcher in the lower half, and keeps other fixed controls", () => {
		const page = fakePage();
		runScript(page);

		expect(page.launcher.style.visibility).toBe("hidden");
		expect(page.headerButton.style.visibility).toBe("");
		expect(page.bottomBar.style.visibility).toBe("");
	});

	it("hides only overlays on a page read, and leaves the text alone", () => {
		const page = fakePage();
		new Function("document", "getComputedStyle", hideOverlaysScript())(
			page.document,
			page.getComputedStyle,
		);

		expect(page.banner.style.visibility).toBe("hidden");
		expect(page.launcher.style.visibility).toBe("hidden");
		expect(page.headerButton.style.visibility).toBe("");
		expect(page.textNodes[0].nodeValue).toBe(
			"Contact someone.real@company.example.org",
		);
		expect(page.avatar.style.visibility).toBe("");
		expect(page.cssAvatar.style.backgroundImage).toBe("");
	});

	it("masks inside open shadow roots", () => {
		const page = fakePage();
		runScript(page);

		expect(page.shadowText.nodeValue).toBe(`Owner: ${MASK_EMAIL}`);
		expect(page.shadowField.value).toBe(MASK_PHONE);
		expect(page.shadowAvatar.style.visibility).toBe("hidden");
	});

	it("drops a round or avatar-named square background image", () => {
		const page = fakePage();
		runScript(page);

		expect(page.cssAvatar.style.backgroundImage).toBe("none");
		expect(page.pxRoundAvatar.style.backgroundImage).toBe("none");
		expect(page.namedAvatar.style.backgroundImage).toBe("none");
		expect(page.labelledAvatar.style.backgroundImage).toBe("none");
	});

	it("keeps logos, icons and large background images", () => {
		const page = fakePage();
		runScript(page);

		expect(page.logo.style.backgroundImage).toBe("");
		expect(page.tinyIcon.style.backgroundImage).toBe("");
		expect(page.wideRoundLogo.style.backgroundImage).toBe("");
		expect(page.hero.style.backgroundImage).toBe("");
	});
});
