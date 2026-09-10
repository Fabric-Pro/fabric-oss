/**
 * SSRF guard on agent deployment URLs (Fizzy #2380, QA round two).
 *
 * Agent discovery takes a URL from the caller and makes the server fetch it,
 * returning `healthy`, a response time and validation errors — enough for an
 * ordinary member to map an internal network. The shared validator was already
 * in this package at three other call sites; the agent registry never got it.
 *
 * What these pin is mostly the *exception*: an agent on `localhost` is the
 * normal case in development and a legitimate one when self-hosted, so the
 * block has to be escapable by the operator without being escapable by the
 * caller.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAgentEndpointAllowed } from "../agent-endpoint-guard";

const ORIGINAL_ALLOWED = process.env.AGENT_DISCOVERY_ALLOWED_HOSTS;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

beforeEach(() => {
	setEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", undefined);
	setEnv("NODE_ENV", "production");
});

afterEach(() => {
	setEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", ORIGINAL_ALLOWED);
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
});

describe("addresses the server must not be aimed at", () => {
	it.each([
		["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
		["http://metadata.google.internal/", "cloud metadata by name"],
		["http://127.0.0.1:9200/", "loopback"],
		["http://localhost:8125/", "loopback by name"],
		["http://10.0.0.5/", "private range"],
		["http://192.168.1.40:5432/", "private range, database port"],
		["http://172.16.4.4/", "private range"],
		["http://[::1]:8080/", "IPv6 loopback"],
		["file:///etc/passwd", "non-HTTP protocol"],
	])("refuses %s (%s)", (url) => {
		expect(() => assertAgentEndpointAllowed(url)).toThrow(
			/Agent endpoint rejected/,
		);
	});

	it("names the variable that would permit it", () => {
		// A self-hoster hitting this needs to know there is a way through,
		// or they will read it as the product not supporting their setup.
		expect(() => assertAgentEndpointAllowed("http://10.0.0.5/")).toThrow(
			/AGENT_DISCOVERY_ALLOWED_HOSTS/,
		);
	});

	it("allows an ordinary public address", () => {
		expect(() =>
			assertAgentEndpointAllowed("https://agents.example.com/a2a"),
		).not.toThrow();
	});
});

describe("the operator's exception", () => {
	it("permits a host the deployment declared", () => {
		setEnv(
			"AGENT_DISCOVERY_ALLOWED_HOSTS",
			"localhost,host.docker.internal",
		);

		expect(() =>
			assertAgentEndpointAllowed("http://localhost:8125/"),
		).not.toThrow();
		expect(() =>
			assertAgentEndpointAllowed("http://host.docker.internal:8000/"),
		).not.toThrow();
	});

	it("permits any port on a declared host", () => {
		// Deliberate. An operator who has said a host is reachable should not
		// have to enumerate the ports an agent might listen on; the host is
		// what decides whether the request leaves the trust boundary.
		setEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "127.0.0.1");

		expect(() =>
			assertAgentEndpointAllowed("http://127.0.0.1:5432/"),
		).not.toThrow();
	});

	it("does not permit a host the deployment did NOT declare", () => {
		setEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "localhost");

		expect(() =>
			assertAgentEndpointAllowed("http://169.254.169.254/"),
		).toThrow(/Agent endpoint rejected/);
	});

	it("is set by the operator, never by the request", () => {
		// The guard reads only the environment. There is no input field, no
		// header and no per-agent flag that widens it — which is the whole
		// reason the exception is safe to have.
		setEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "");

		expect(() =>
			assertAgentEndpointAllowed("http://localhost:8125/"),
		).toThrow(/Agent endpoint rejected/);
	});
});

describe("production versus a checkout", () => {
	it("has no default exception in production", () => {
		setEnv("NODE_ENV", "production");

		expect(() =>
			assertAgentEndpointAllowed("http://localhost:8125/"),
		).toThrow(/Agent endpoint rejected/);
	});

	it("permits loopback outside production so a checkout works unconfigured", () => {
		setEnv("NODE_ENV", "development");

		expect(() =>
			assertAgentEndpointAllowed("http://localhost:8125/"),
		).not.toThrow();
	});

	it("still refuses link-local and LAN outside production", () => {
		// The dev default is loopback, not "anything private". Cloud metadata
		// is reachable from a developer laptop on a corporate network too.
		setEnv("NODE_ENV", "development");

		expect(() =>
			assertAgentEndpointAllowed("http://169.254.169.254/"),
		).toThrow(/Agent endpoint rejected/);
		expect(() => assertAgentEndpointAllowed("http://10.0.0.5/")).toThrow(
			/Agent endpoint rejected/,
		);
	});
});
