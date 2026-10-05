/**
 * Inbound verification uses the deployment's own secret, never one stored in
 * a tenant's connection (Fizzy #2860). The unified webhook route used to pass
 * the most recently used connection from ANY tenant as `credentials`, so a
 * `signing_secret` / `webhook_secret` saved on one tenant's connection decided
 * verification for every tenant.
 */

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackChannelAdapter } from "../slack/index";
import { telegramChannelAdapter } from "../telegram/index";
import type { InboundContext, VerifyOutcome } from "../types";

const APP_SIGNING_SECRET = "app-signing-secret";
const TENANT_SECRET = "tenant-chosen-secret";

// The adapters no longer take credentials. Call through a wider signature to
// prove a second argument (what the old route passed) is ignored.
type LegacyVerify = (
	ctx: InboundContext,
	credentials?: Record<string, unknown>,
) => VerifyOutcome;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("slackChannelAdapter.verifyInbound", () => {
	const body = JSON.stringify({
		type: "event_callback",
		event_id: "Ev1",
		team_id: "T1",
		event: {
			type: "app_mention",
			channel: "C1",
			user: "U1",
			text: "<@B1> hello",
			ts: "1700000000.000100",
		},
	});

	function signed(secret: string): InboundContext {
		const ts = String(Math.floor(Date.now() / 1000));
		const sig = `v0=${createHmac("sha256", secret)
			.update(`v0:${ts}:${body}`)
			.digest("hex")}`;
		return {
			headers: {
				"x-slack-signature": sig,
				"x-slack-request-timestamp": ts,
			},
			rawBody: body,
		};
	}

	it("accepts an event signed with the app's signing secret in production, ignoring conflicting credentials", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("SLACK_SIGNING_SECRET", APP_SIGNING_SECRET);
		const verify = slackChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(signed(APP_SIGNING_SECRET), {
			signing_secret: TENANT_SECRET,
			SLACK_SIGNING_SECRET: TENANT_SECRET,
		});
		expect(out.kind).toBe("valid");
	});

	it("skips the signature check outside production when no secret is configured (local dev)", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("SLACK_SIGNING_SECRET", "");
		const out = slackChannelAdapter.verifyInbound({
			headers: {},
			rawBody: body,
		}) as VerifyOutcome;
		expect(out.kind).toBe("valid");
	});

	it("rejects an event signed with a tenant-stored secret, even when that secret is passed as credentials", () => {
		vi.stubEnv("SLACK_SIGNING_SECRET", APP_SIGNING_SECRET);
		const verify = slackChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(signed(TENANT_SECRET), {
			signing_secret: TENANT_SECRET,
			SLACK_SIGNING_SECRET: TENANT_SECRET,
		});
		expect(out).toEqual({
			kind: "invalid",
			reason: "slack signature mismatch",
		});
	});

	it("rejects in production when the app has no signing secret, whatever the credentials hold", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("SLACK_SIGNING_SECRET", "");
		const verify = slackChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(signed(TENANT_SECRET), {
			signing_secret: TENANT_SECRET,
		});
		expect(out).toEqual({
			kind: "invalid",
			reason: "no slack signing secret configured",
		});
	});

	it("rejects an unsigned event when the app has a signing secret", () => {
		vi.stubEnv("SLACK_SIGNING_SECRET", APP_SIGNING_SECRET);
		const out = slackChannelAdapter.verifyInbound({
			headers: {},
			rawBody: body,
		}) as VerifyOutcome;
		expect(out).toEqual({
			kind: "invalid",
			reason: "missing slack signature headers",
		});
	});
});

describe("telegramChannelAdapter.verifyInbound", () => {
	const body = JSON.stringify({
		update_id: 42,
		message: {
			message_id: 1,
			date: 1_700_000_000,
			chat: { id: 1001, type: "private" },
			from: { id: 7, is_bot: false, username: "someone" },
			text: "hello",
		},
	});

	function withSecret(secret?: string): InboundContext {
		return {
			headers: secret
				? { "x-telegram-bot-api-secret-token": secret }
				: {},
			rawBody: body,
		};
	}

	it("accepts an update carrying the deployment's webhook secret in production, ignoring conflicting credentials", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", APP_SIGNING_SECRET);
		const verify = telegramChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(withSecret(APP_SIGNING_SECRET), {
			webhook_secret: TENANT_SECRET,
		});
		expect(out.kind).toBe("valid");
	});

	it("skips the secret check outside production when no secret is configured (local dev)", () => {
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
		const out = telegramChannelAdapter.verifyInbound(
			withSecret(),
		) as VerifyOutcome;
		expect(out.kind).toBe("valid");
	});

	it("rejects an update carrying a tenant-stored secret, even when that secret is passed as credentials", () => {
		vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", APP_SIGNING_SECRET);
		const verify = telegramChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(withSecret(TENANT_SECRET), {
			webhook_secret: TENANT_SECRET,
		});
		expect(out).toEqual({
			kind: "invalid",
			reason: "secret-token mismatch",
		});
	});

	it("rejects an update with no secret header", () => {
		vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", APP_SIGNING_SECRET);
		const out = telegramChannelAdapter.verifyInbound(
			withSecret(),
		) as VerifyOutcome;
		expect(out).toEqual({
			kind: "invalid",
			reason: "secret-token mismatch",
		});
	});

	it("rejects every update in production when no webhook secret is configured", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
		const verify = telegramChannelAdapter.verifyInbound as LegacyVerify;
		const out = verify(withSecret(TENANT_SECRET), {
			webhook_secret: TENANT_SECRET,
		});
		expect(out).toEqual({
			kind: "invalid",
			reason: "no telegram webhook secret configured",
		});
	});
});
