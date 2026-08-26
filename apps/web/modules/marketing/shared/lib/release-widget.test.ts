import { describe, expect, it } from "vitest";
import { resolveReleaseWidgetParams } from "./embed-params";
import { buildReleaseWidgetSnippet } from "./embed-snippet";

describe("resolveReleaseWidgetParams", () => {
	it("drops invalid accent, clamps radius", () => {
		const p = resolveReleaseWidgetParams({ accent: "red", radius: "999" });
		expect(p.accent).toBeNull();
		expect(p.radius).toBe(24);
	});

	it("accepts valid accent + #RGB short form", () => {
		expect(resolveReleaseWidgetParams({ accent: "#9F2A3A" }).accent).toBe(
			"#9F2A3A",
		);
		expect(resolveReleaseWidgetParams({ accent: "#abc" }).accent).toBe(
			"#abc",
		);
	});

	it("font outside allowlist -> system; width non-100% clamped 280..640; bad density -> comfortable", () => {
		expect(resolveReleaseWidgetParams({ font: "comic" }).font).toBe(
			"system",
		);
		expect(resolveReleaseWidgetParams({ width: "99999" }).width).toBe(
			"640",
		);
		expect(resolveReleaseWidgetParams({ width: "100%" }).width).toBe(
			"100%",
		);
		expect(resolveReleaseWidgetParams({ density: "nope" }).density).toBe(
			"comfortable",
		);
	});

	it("accepts theme=dark", () => {
		expect(resolveReleaseWidgetParams({ theme: "dark" }).theme).toBe(
			"dark",
		);
	});

	it("accepts the allowlisted fonts and density=compact", () => {
		expect(resolveReleaseWidgetParams({ font: "inter" }).font).toBe(
			"inter",
		);
		expect(resolveReleaseWidgetParams({ font: "serif" }).font).toBe(
			"serif",
		);
		expect(resolveReleaseWidgetParams({ density: "compact" }).density).toBe(
			"compact",
		);
	});

	it("clamps radius low end and width low end", () => {
		expect(resolveReleaseWidgetParams({ radius: "-5" }).radius).toBe(0);
		expect(resolveReleaseWidgetParams({ width: "10" }).width).toBe("280");
	});

	it("defaults when params absent", () => {
		const p = resolveReleaseWidgetParams(undefined);
		expect(p).toEqual({
			theme: "light",
			accent: null,
			font: "system",
			radius: 12,
			width: "480",
			density: "comfortable",
		});
	});

	it("neutralizes CSS-injection payloads in accent/width", () => {
		// accent: only #RGB / #RRGGBB survive — every payload below is dropped to
		// null, so nothing attacker-controlled reaches the `--primary` inline style.
		expect(
			resolveReleaseWidgetParams({ accent: "red;}body{display:none}" })
				.accent,
		).toBeNull();
		expect(
			resolveReleaseWidgetParams({ accent: "#abc;background:url(x)" })
				.accent,
		).toBeNull();
		expect(
			resolveReleaseWidgetParams({ accent: "var(--x)" }).accent,
		).toBeNull();
		expect(
			resolveReleaseWidgetParams({ accent: "#abc\n;evil" }).accent,
		).toBeNull();
		// width: integer-clamped, so any payload collapses to a bare clamped number
		// string (parseInt stops at the first non-digit) or the default — no payload
		// string survives. "100%;evil" → parseInt "100" → clamped up to the 280 floor.
		expect(resolveReleaseWidgetParams({ width: "100%;evil" }).width).toBe(
			"280",
		);
		expect(resolveReleaseWidgetParams({ width: "480;}x{" }).width).toBe(
			"480",
		);
		// The invariant that matters: width is always "100%" or a pure integer string.
		for (const payload of [
			"100%;evil",
			"480;}x{",
			"calc(100% + 1px)",
			"</style>",
			"480px;color:red",
		]) {
			expect(
				/^(100%|\d+)$/.test(
					resolveReleaseWidgetParams({ width: payload }).width,
				),
			).toBe(true);
		}
	});
});

describe("buildReleaseWidgetSnippet", () => {
	it("snippet targets /embed/release-notes with token + only whitelisted params", () => {
		const s = buildReleaseWidgetSnippet("https://x.io/", {
			token: "TOK",
			theme: "dark",
			accent: "#9F2A3A",
		});
		expect(s).toContain('src="https://x.io/embed/release-notes?t=TOK');
		expect(s).toContain("theme=dark");
		expect(s).toContain("accent=%239F2A3A"); // # url-encoded
	});

	it("omits params that are not provided", () => {
		const s = buildReleaseWidgetSnippet("https://x.io", { token: "TOK" });
		// Only the token should be in the query string — no extra params appended.
		expect(s).toContain('src="https://x.io/embed/release-notes?t=TOK"');
		expect(s).not.toContain("theme=");
		expect(s).not.toContain("accent=");
		expect(s).not.toContain("font=");
		expect(s).not.toContain("radius=");
		// Guard against the *query* param `width=`, not the literal iframe
		// `width="100%"` HTML attribute the snippet always carries.
		expect(s).not.toContain("&width=");
		expect(s).not.toContain("density=");
	});

	it("includes radius=0 (does not treat 0 as absent)", () => {
		const s = buildReleaseWidgetSnippet("https://x.io", {
			token: "TOK",
			radius: 0,
		});
		expect(s).toContain("radius=0");
	});

	it("derives the iframe max-width from a pixel width", () => {
		const s = buildReleaseWidgetSnippet("https://x.io", {
			token: "TOK",
			width: "640",
		});
		expect(s).toContain("max-width:640px");
		// the query param still carries the raw width value
		expect(s).toContain("width=640");
	});

	it("uses max-width:100% for a full-width widget", () => {
		const s = buildReleaseWidgetSnippet("https://x.io", {
			token: "TOK",
			width: "100%",
		});
		expect(s).toContain("max-width:100%");
	});

	it("defaults to max-width:100% when no width is provided", () => {
		const s = buildReleaseWidgetSnippet("https://x.io", { token: "TOK" });
		expect(s).toContain("max-width:100%");
		// no hardcoded legacy cap
		expect(s).not.toContain("max-width:480px");
	});

	it("snippet neutralizes malicious width payloads", () => {
		// publicWidgetConfig is stored unvalidated, so a saved free-form width could carry
		// an attribute/style-breakout payload. The snippet builder must normalize width to
		// the SAME invariant the embed page enforces ("100%" or a clamped int 280..640)
		// BEFORE it reaches the style attribute, so no raw payload survives.
		const s1 = buildReleaseWidgetSnippet("https://x.io", {
			token: "T",
			width: '640" onload="alert(1)',
		});
		expect(s1).toContain("max-width:640px"); // parseInt -> 640, clamped
		expect(s1).not.toContain("onload"); // attribute-breakout payload stripped
		// parseInt("100%;}</style>", 10) === 100 -> clamped UP to the 280 floor.
		const s2 = buildReleaseWidgetSnippet("https://x.io", {
			token: "T",
			width: "100%;}</style>",
		});
		expect(s2).toContain("max-width:280px");
		expect(s2).not.toContain("</style>"); // style-breakout payload stripped
		// The load-bearing invariant: between `max-width:` and the closing quote of the
		// style attribute, the value is ONLY "100%" or "<digits>px" — no semicolon,
		// brace, or angle-bracket (the chars that would break out of the attr/style)
		// can appear before that closing quote. The capture stops at the first `"`.
		expect(s2).not.toMatch(/max-width:[^"]*[;}<>]/);
		expect(s1).not.toMatch(/max-width:[^"]*[;}<>]/);
		// And the value itself is exactly "100%" or "<int>px".
		expect(/style="border:0;max-width:(100%|\d+px)"/.test(s1)).toBe(true);
		expect(/style="border:0;max-width:(100%|\d+px)"/.test(s2)).toBe(true);
		// The query param is normalized too (no raw payload smuggled via the URL).
		expect(s1).toContain("width=640");
		expect(s2).toContain("width=280");
		expect(s1).not.toContain("onload");
		expect(s2).not.toContain("%3C%2Fstyle%3E"); // no url-encoded </style> either
	});
});
