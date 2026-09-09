/**
 * Tests for the Microsoft error classifiers shared by apps/web, @repo/api,
 * and @repo/temporal (see connection-errors.ts for why this file is
 * dependency-free).
 */

import { describe, expect, it } from "vitest";
import {
	isMicrosoftAccessDeniedError,
	isMicrosoftNotConnectedError,
} from "../connection-errors";

describe("isMicrosoftNotConnectedError", () => {
	it("matches the not-connected message", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("matches a reconnect-lifecycle message", () => {
		expect(
			isMicrosoftNotConnectedError(
				"Token refresh failed. Please reconnect your Microsoft account in Settings > Integrations.",
			),
		).toBe(true);
	});

	it("does not match an unrelated error", () => {
		expect(isMicrosoftNotConnectedError("ECONNRESET")).toBe(false);
	});

	it("does not match a Graph 403 access-denied error", () => {
		expect(
			isMicrosoftNotConnectedError(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
			),
		).toBe(false);
	});
});

describe("isMicrosoftAccessDeniedError", () => {
	it("matches the real Graph 403 shape (Fizzy #2450)", () => {
		expect(
			isMicrosoftAccessDeniedError(
				'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
			),
		).toBe(true);
	});

	it("matches on the Forbidden error code alone", () => {
		expect(
			isMicrosoftAccessDeniedError(
				'{"error":{"code":"Forbidden","message":"Access is denied"}}',
			),
		).toBe(true);
	});

	it("does not match a not-connected error", () => {
		expect(
			isMicrosoftAccessDeniedError(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		).toBe(false);
	});

	it("does not match an unrelated error", () => {
		expect(isMicrosoftAccessDeniedError("ECONNRESET")).toBe(false);
	});

	it("does not match a different Graph status code", () => {
		expect(
			isMicrosoftAccessDeniedError(
				'Microsoft Graph API error: 404 Not Found - {"error":{"code":"NotFound","message":"Chat not found"}}',
			),
		).toBe(false);
	});

	// `graphRequest` (index.ts) also returns a 403 unchanged — unwrapped by
	// neither `needsRefresh` (no refresh token) nor the post-refresh retry —
	// for six auth-shaped markers. Those are the SAME account-wide,
	// reconnect-your-account condition `isMicrosoftNotConnectedError` covers
	// for other call shapes, not "this account can't read this one chat", so
	// none of them may classify as access-denied.
	describe("auth-shaped 403s (token problem, not per-resource denial)", () => {
		it("does not match the 'No authorization information' message marker", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"No authorization information present"}}',
				),
			).toBe(false);
		});

		it("does not match the 'InvalidAuthenticationToken' message marker", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"InvalidAuthenticationToken: token is malformed"}}',
				),
			).toBe(false);
		});

		it("does not match the 'Access token has expired' message marker", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"Access token has expired."}}',
				),
			).toBe(false);
		});

		it("does not match the InvalidAuthenticationToken error code", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"InvalidAuthenticationToken","message":"Access token is empty."}}',
				),
			).toBe(false);
		});

		it("does not match the ExpiredToken error code", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"ExpiredToken","message":"Token expired."}}',
				),
			).toBe(false);
		});

		it("does not match the AuthenticationError error code", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"AuthenticationError","message":"Authentication failed."}}',
				),
			).toBe(false);
		});

		it("still matches the genuine Forbidden body with no auth marker present", () => {
			expect(
				isMicrosoftAccessDeniedError(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
				),
			).toBe(true);
		});
	});
});
