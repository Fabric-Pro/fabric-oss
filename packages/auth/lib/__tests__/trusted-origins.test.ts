import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@repo/logs";
import { buildTrustedOrigins } from "../trusted-origins";

const APP_URL = "https://fabric.pro";

describe("buildTrustedOrigins — base entries", () => {
	beforeEach(() => vi.resetAllMocks());

	it("always includes appUrl", () => {
		const r = buildTrustedOrigins(
			{ NODE_ENV: "production" } as never,
			APP_URL,
		);
		expect(r).toContain(APP_URL);
	});

	it("does not implicitly trust any other host", () => {
		const r = buildTrustedOrigins(
			{ NODE_ENV: "production" } as never,
			"https://example.com",
		);
		expect(r).not.toContain("https://fabric.pro");
		expect(r).not.toContain("https://www.fabric.pro");
	});

	it("aliases localhost ↔ 127.0.0.1", () => {
		const a = buildTrustedOrigins(
			{ NODE_ENV: "development" } as never,
			"http://localhost:3001",
		);
		expect(a).toContain("http://127.0.0.1:3001");

		const b = buildTrustedOrigins(
			{ NODE_ENV: "development" } as never,
			"http://127.0.0.1:3001",
		);
		expect(b).toContain("http://localhost:3001");
	});
});

describe("buildTrustedOrigins — additional origins from env", () => {
	beforeEach(() => vi.resetAllMocks());

	it("adds entries from AUTH_TRUSTED_ORIGINS (comma-separated)", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "production",
				AUTH_TRUSTED_ORIGINS:
					"https://app.example.com, https://admin.example.com",
			} as never,
			APP_URL,
		);
		expect(r).toContain("https://app.example.com");
		expect(r).toContain("https://admin.example.com");
	});

	it("falls back to CORS_ALLOWED_ORIGINS when AUTH_TRUSTED_ORIGINS is unset", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "production",
				CORS_ALLOWED_ORIGINS: "https://app.example.com",
			} as never,
			APP_URL,
		);
		expect(r).toContain("https://app.example.com");
	});

	it("does not add anything when neither env var is set", () => {
		const r = buildTrustedOrigins(
			{ NODE_ENV: "production" } as never,
			APP_URL,
		);
		expect(r).toEqual([APP_URL]);
	});
});

describe("buildTrustedOrigins — Vercel preview URLs", () => {
	beforeEach(() => vi.resetAllMocks());

	it("includes preview URLs only when VERCEL_ENV=preview", () => {
		const prod = buildTrustedOrigins(
			{
				VERCEL_ENV: "production",
				VERCEL_URL: "p.vercel.app",
				VERCEL_BRANCH_URL: "feature.vercel.app",
				NODE_ENV: "production",
			} as never,
			APP_URL,
		);
		expect(prod).not.toContain("https://p.vercel.app");
		expect(prod).not.toContain("https://feature.vercel.app");
	});

	it("includes both preview URLs when VERCEL_ENV=preview", () => {
		const preview = buildTrustedOrigins(
			{
				VERCEL_ENV: "preview",
				VERCEL_URL: "p.vercel.app",
				VERCEL_BRANCH_URL: "feature.vercel.app",
				NODE_ENV: "production",
			} as never,
			APP_URL,
		);
		expect(preview).toContain("https://p.vercel.app");
		expect(preview).toContain("https://feature.vercel.app");
	});

	it("does not include preview URLs in development without VERCEL_ENV=preview", () => {
		const dev = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				VERCEL_URL: "p.vercel.app",
			} as never,
			APP_URL,
		);
		expect(dev).not.toContain("https://p.vercel.app");
	});
});

describe("buildTrustedOrigins — DEV_TUNNEL_URL", () => {
	beforeEach(() => vi.resetAllMocks());

	it("accepts a valid https ngrok-free.app host in development", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://abc.ngrok-free.app",
			} as never,
			APP_URL,
		);
		expect(r).toContain("https://abc.ngrok-free.app");
	});

	it("accepts ngrok.app and ngrok.io suffixes", () => {
		const a = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://abc.ngrok.app",
			} as never,
			APP_URL,
		);
		expect(a).toContain("https://abc.ngrok.app");
		const b = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://xyz.ngrok.io",
			} as never,
			APP_URL,
		);
		expect(b).toContain("https://xyz.ngrok.io");
	});

	it("rejects http DEV_TUNNEL_URL and warns", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "http://abc.ngrok.io",
			} as never,
			APP_URL,
		);
		expect(r).not.toContain("http://abc.ngrok.io");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "trusted_origins.rejected",
				reason: "non-https",
			}),
			expect.any(String),
		);
	});

	it("rejects DEV_TUNNEL_URL with a non-tunnel host suffix", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://abc.evil.com",
			} as never,
			APP_URL,
		);
		expect(r).not.toContain("https://abc.evil.com");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "trusted_origins.rejected",
				reason: "bad-host",
			}),
			expect.any(String),
		);
	});

	it("rejects malformed DEV_TUNNEL_URL", () => {
		const r = buildTrustedOrigins(
			{ NODE_ENV: "development", DEV_TUNNEL_URL: "not a url" } as never,
			APP_URL,
		);
		expect(r).not.toContain("not a url");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "trusted_origins.rejected",
				reason: "parse-error",
			}),
			expect.any(String),
		);
	});

	it("ignores DEV_TUNNEL_URL in production", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "production",
				DEV_TUNNEL_URL: "https://abc.ngrok-free.app",
			} as never,
			APP_URL,
		);
		expect(r).not.toContain("https://abc.ngrok-free.app");
	});

	it("rejects multi-label ngrok hostname like evil.com.ngrok.io", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://evil.com.ngrok.io",
			} as never,
			APP_URL,
		);
		expect(r).not.toContain("https://evil.com.ngrok.io");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "trusted_origins.rejected",
				reason: "bad-host",
			}),
			expect.any(String),
		);
	});

	it("rejects empty-subdomain ngrok URL", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://.ngrok.io",
			} as never,
			APP_URL,
		);
		expect(r).not.toContain("https://.ngrok.io");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "trusted_origins.rejected" }),
			expect.any(String),
		);
	});

	it("accepts a two-label devtunnels.ms host in development", () => {
		const r = buildTrustedOrigins(
			{
				NODE_ENV: "development",
				DEV_TUNNEL_URL: "https://abc-3001.usw2.devtunnels.ms",
			} as never,
			APP_URL,
		);
		expect(r).toContain("https://abc-3001.usw2.devtunnels.ms");
	});

	it("rejects a devtunnels.ms host with the wrong label count", () => {
		for (const url of [
			"https://abc.devtunnels.ms",
			"https://a.b.c.devtunnels.ms",
			"https://.usw2.devtunnels.ms",
		]) {
			const r = buildTrustedOrigins(
				{ NODE_ENV: "development", DEV_TUNNEL_URL: url } as never,
				APP_URL,
			);
			expect(r).not.toContain(url);
		}
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "trusted_origins.rejected",
				reason: "bad-host",
			}),
			expect.any(String),
		);
	});
});
