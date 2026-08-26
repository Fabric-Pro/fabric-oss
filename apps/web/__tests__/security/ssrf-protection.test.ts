/**
 * Tests for SSRF (Server-Side Request Forgery) Protection
 * Validates that internal/private network addresses are blocked
 */

import { isPrivateOrLocalUrl } from "@repo/utils/url-security";
import { describe, expect, it } from "vitest";

describe("SSRF Protection", () => {
	describe("Private IPv4 Blocking", () => {
		it("should block 10.x.x.x addresses", () => {
			const blockedAddresses = [
				"http://10.0.0.1/api",
				"http://10.0.0.1:8080/admin",
				"http://10.255.255.255/",
				"http://10.1.2.3/internal",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should block 172.16-31.x.x addresses", () => {
			const blockedAddresses = [
				"http://172.16.0.1/",
				"http://172.20.0.1/api",
				"http://172.31.255.255/",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should NOT block 172.15.x.x or 172.32.x.x", () => {
			// These are NOT private addresses
			const allowedAddresses = [
				"http://172.15.0.1/",
				"http://172.32.0.1/",
			];

			for (const url of allowedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(false);
			}
		});

		it("should block 192.168.x.x addresses", () => {
			const blockedAddresses = [
				"http://192.168.0.1/",
				"http://192.168.1.1/admin",
				"http://192.168.255.255/",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should block 127.x.x.x loopback addresses", () => {
			const blockedAddresses = [
				"http://127.0.0.1/",
				"http://127.0.0.1:3000/api",
				"http://127.1.2.3/",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should block 169.254.x.x link-local addresses", () => {
			const blockedAddresses = [
				"http://169.254.0.1/",
				"http://169.254.169.254/latest/meta-data/", // AWS metadata
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});
	});

	describe("Localhost Blocking", () => {
		it("should block localhost hostname", () => {
			const blockedAddresses = [
				"http://localhost/",
				"http://localhost:3000/api",
				"http://localhost:8080/admin",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should block IPv6 loopback", () => {
			const blockedAddresses = ["http://[::1]/", "http://[::1]:3000/"];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should block IPv4-mapped IPv6 loopback addresses", () => {
			const blockedAddresses = [
				"http://[::ffff:127.0.0.1]/",
				"http://[::ffff:7f00:1]/",
				"http://[::ffff:192.168.1.10]/",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});
	});

	describe("Local Domain Blocking", () => {
		it("should block .local domains", () => {
			const blockedAddresses = [
				"http://myserver.local/",
				"http://internal.local/api",
				"http://printer.local:9100/",
			];

			for (const url of blockedAddresses) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});
	});

	describe("Protocol Validation", () => {
		it("should only allow http and https protocols", () => {
			const blockedProtocols = [
				"file:///etc/passwd",
				"ftp://ftp.example.com/",
				"gopher://example.com/",
				"dict://example.com/",
			];

			for (const url of blockedProtocols) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});

		it("should allow http and https", () => {
			const allowedUrls = [
				"http://api.example.com/",
				"https://api.example.com/",
			];

			for (const url of allowedUrls) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(false);
			}
		});
	});

	describe("Public URL Allowing", () => {
		it("should allow valid public URLs", () => {
			const allowedUrls = [
				"https://api.example.com/v1/data",
				"https://httpbin.org/get",
				"https://jsonplaceholder.typicode.com/posts",
				"http://worldtimeapi.org/api/timezone/America/New_York",
			];

			for (const url of allowedUrls) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(false);
			}
		});
	});

	describe("Invalid URL Handling", () => {
		it("should block invalid URLs", () => {
			const invalidUrls = ["not-a-url", "://missing-protocol.com", ""];

			for (const url of invalidUrls) {
				const result = isPrivateOrLocalUrl(url);
				expect(result).toBe(true);
			}
		});
	});
});
