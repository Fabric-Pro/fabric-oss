/**
 * Placeholder data for a release-notes screenshot. The capture environment is
 * confirmed by an admin to show sample data only; this is the second line:
 * just before the picture, email addresses, phone numbers and the name the
 * capture signed in with become placeholders and avatar images are hidden.
 * Other names and amounts cannot be told apart from sample data, so the
 * attestation still covers those.
 */

export const MASK_EMAIL = "jane.doe@example.com";
export const MASK_PHONE = "+1 555 0100";
export const MASK_NAME = "Jane Doe";

/** Sources rather than RegExp objects: they cross into the page as JSON. */
const MASK_PATTERNS = {
	email: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
	phone: "(?:\\+\\d{1,3}[\\s.-]?)?(?:\\(\\d{2,4}\\)[\\s.-]?|\\b\\d{2,4}[\\s.-])\\d{3,4}[\\s.-]?\\d{3,4}\\b",
} as const;

/**
 * One case-insensitive source matching any of `terms` as a whole word, or
 * null when there are none. Each term is escaped, so it matches literally.
 */
function termsPattern(terms: readonly string[]): string | null {
	const unique = new Set(terms.map((term) => term.trim()).filter(Boolean));
	const escaped = [...unique]
		.sort((a, b) => b.length - a.length)
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return escaped.length > 0
		? `(?<![A-Za-z0-9])(?:${escaped.join("|")})(?![A-Za-z0-9])`
		: null;
}

/**
 * The terms that name the account a capture signs in with: the username and,
 * when it is an email address, its local part.
 */
export function signInMaskTerms(username: string | null | undefined): string[] {
	const name = username?.trim();
	if (!name) {
		return [];
	}
	const at = name.indexOf("@");
	return at > 0 ? [name, name.slice(0, at)] : [name];
}

/**
 * The text with every email address and phone number replaced, and every
 * one of `extraTerms` replaced with a placeholder name.
 */
export function maskText(
	text: string,
	extraTerms: readonly string[] = [],
): string {
	const terms = termsPattern(extraTerms);
	const masked = text
		.replace(new RegExp(MASK_PATTERNS.email, "g"), MASK_EMAIL)
		.replace(new RegExp(MASK_PATTERNS.phone, "g"), MASK_PHONE);
	return terms ? masked.replace(new RegExp(terms, "gi"), MASK_NAME) : masked;
}

/** In-page source: `roots`, the document and every open shadow root in it. */
const COLLECT_ROOTS = `const roots = [document];
	for (let i = 0; i < roots.length; i++) {
		for (const element of Array.from(roots[i].querySelectorAll("*"))) {
			if (element.shadowRoot) {
				roots.push(element.shadowRoot);
			}
		}
	}`;

/**
 * In-page source: `hideOverlay(element, style)` hides a floating cookie or
 * consent banner that offers a choice such as Accept or Decline (a sticky
 * "Consent" menu item stays), and a small fixed button in the lower half of
 * the window (a chat or assistant launcher).
 */
const OVERLAY_RULES = `const consent = /cookie|consent|your privacy/i;
	const consentChoice = /accept|agree|reject|decline|allow|got it/i;
	const viewportHeight = document.documentElement
		? document.documentElement.clientHeight
		: 0;
	const isLauncher = (element) => {
		const box = element.getBoundingClientRect();
		if (
			box.width < 24 ||
			box.width > 96 ||
			box.height < 24 ||
			box.height > 96 ||
			box.top < viewportHeight / 2
		) {
			return false;
		}
		return (
			/^(BUTTON|A)$/.test(element.tagName || "") ||
			element.getAttribute("role") === "button" ||
			element.querySelectorAll("button, a, [role='button']").length > 0
		);
	};
	const hideOverlay = (element, style) => {
		if (style.position !== "fixed" && style.position !== "sticky") {
			return;
		}
		if (style.position === "fixed" && isLauncher(element)) {
			element.style.visibility = "hidden";
			return;
		}
		const text = element.textContent || "";
		if (text.length >= 1500 || !consent.test(text)) {
			return;
		}
		const offersChoice = Array.from(
			element.querySelectorAll("button, a, [role='button']"),
		).some((choice) => consentChoice.test(choice.textContent || ""));
		if (offersChoice) {
			element.style.visibility = "hidden";
		}
	};`;

/**
 * The in-page masking as source text for `page.evaluate`. A function would be
 * serialized from the worker's bundled code, where the bundler wraps named
 * functions in a `__name` helper that does not exist in the page; text it
 * cannot rewrite. Covers the document and every open shadow root: rewrites
 * text nodes and form values (including `extraTerms`, such as the name the
 * capture signed in with), hides images that look like avatars, drops
 * background images that look like avatars (small, square, and round or
 * named so; logos and icons stay), and hides overlays (`OVERLAY_RULES`).
 */
export function maskPageScript(extraTerms: readonly string[]): string {
	return `(() => {
	const args = ${JSON.stringify({
		email: MASK_EMAIL,
		phone: MASK_PHONE,
		name: MASK_NAME,
		emailPattern: MASK_PATTERNS.email,
		phonePattern: MASK_PATTERNS.phone,
		termsPattern: termsPattern(extraTerms),
	})};
	const mask = (value) => {
		const masked = value
			.replace(new RegExp(args.emailPattern, "g"), args.email)
			.replace(new RegExp(args.phonePattern, "g"), args.phone);
		return args.termsPattern
			? masked.replace(new RegExp(args.termsPattern, "gi"), args.name)
			: masked;
	};
	${COLLECT_ROOTS}
	${OVERLAY_RULES}
	const avatarHint = /avatar|profile|user|member|person/i;
	const looksLikeAvatar = (element, style) => {
		const box = element.getBoundingClientRect();
		const ratio = box.height > 0 ? box.width / box.height : 0;
		if (
			box.width < 16 ||
			box.width > 96 ||
			box.height < 16 ||
			box.height > 96 ||
			ratio < 0.75 ||
			ratio > 1.33
		) {
			return false;
		}
		const radius = style.borderTopLeftRadius || style.borderRadius || "";
		const amount = parseFloat(radius) || 0;
		const round = radius.trim().endsWith("%")
			? amount >= 25
			: amount >= box.width * 0.25;
		const hint = [
			String(element.className || ""),
			element.getAttribute("aria-label") || "",
			element.getAttribute("alt") || "",
		].join(" ");
		return round || avatarHint.test(hint);
	};
	for (const root of roots) {
		const walker = document.createTreeWalker(
			root === document ? document.body : root,
			NodeFilter.SHOW_TEXT,
		);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.nodeValue || "";
			const masked = mask(text);
			if (masked !== text) {
				node.nodeValue = masked;
			}
		}
		for (const field of Array.from(root.querySelectorAll("input, textarea"))) {
			if (field.type === "password" || field.type === "hidden") {
				continue;
			}
			const masked = mask(field.value);
			if (masked !== field.value) {
				field.value = masked;
			}
			const placeholder = field.getAttribute("placeholder");
			if (placeholder) {
				field.setAttribute("placeholder", mask(placeholder));
			}
		}
		for (const image of Array.from(root.querySelectorAll("img"))) {
			const hint = (image.alt + " " + image.className + " " + image.src).toLowerCase();
			const small = image.width > 0 && image.width <= 64 && image.height <= 64;
			if (hint.includes("avatar") || hint.includes("profile") || small) {
				image.style.visibility = "hidden";
			}
		}
		for (const element of Array.from(root.querySelectorAll("*"))) {
			const style = getComputedStyle(element);
			if (
				(style.backgroundImage || "").includes("url(") &&
				looksLikeAvatar(element, style)
			) {
				element.style.backgroundImage = "none";
			}
			hideOverlay(element, style);
		}
	}
})()`;
}

/**
 * Only the overlay part of the masking, for every page read: a consent
 * banner or a launcher left in place covers controls the capture must click.
 * Changes no text, so the model reads the page as it is.
 */
export function hideOverlaysScript(): string {
	return `(() => {
	${COLLECT_ROOTS}
	${OVERLAY_RULES}
	for (const root of roots) {
		for (const element of Array.from(root.querySelectorAll("*"))) {
			hideOverlay(element, getComputedStyle(element));
		}
	}
})()`;
}
