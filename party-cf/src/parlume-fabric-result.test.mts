import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const { parseParlumeFabricResult, ParlumeVoiceAddresses } = loadParlumeModule(
	"./parlume-fabric-result.ts",
	async () => Response.json({}),
) as {
	parseParlumeFabricResult(body: unknown): unknown;
	ParlumeVoiceAddresses: new (
		known?: string[],
	) => {
		noteResult(text: string): void;
		known(): string[];
		unverified(post: string, chat: Array<{ text: string }>): string[];
	};
};

test("the worker's result body is validated", () => {
	assert.deepEqual(
		plain(
			parseParlumeFabricResult({
				job: "J4",
				status: "completed",
				text: "Done.",
				chatTags: ["P2", "bogus"],
			}),
		),
		{ job: "J4", status: "completed", text: "Done.", chatTags: ["P2"] },
	);
	assert.deepEqual(
		plain(
			parseParlumeFabricResult({
				job: "J4",
				status: "completed",
				text: "Done.",
				turnId: "turn-1",
			}),
		),
		{
			job: "J4",
			status: "completed",
			text: "Done.",
			chatTags: [],
			turnId: "turn-1",
		},
	);
	assert.equal(
		plain(
			parseParlumeFabricResult({
				job: "J4",
				status: "completed",
				text: "Done.",
				turnId: "x".repeat(129),
			}),
		).turnId,
		undefined,
	);
	for (const body of [
		{ job: "4", status: "completed", text: "x" },
		{ job: "J4", status: "running", text: "x" },
		{ job: "J4", status: "completed", text: " " },
		null,
	]) {
		assert.equal(parseParlumeFabricResult(body), null);
	}
});

test("only addresses a Fabric result or the meeting chat gave may be posted", () => {
	const addresses = new ParlumeVoiceAddresses();
	addresses.noteResult(
		"F-12 — https://fabric.example/app/projects/p/stories/F-12. Ready.",
	);
	const chat = [{ text: "Repo: www.example.com/example-org/app, see it." }];

	assert.deepEqual(
		plain(
			addresses.unverified(
				"F-12: https://fabric.example/app/projects/p/stories/F-12\nRepo: www.example.com/example-org/app",
				chat,
			),
		),
		[],
	);
	assert.deepEqual(
		plain(
			addresses.unverified(
				"Repo: github.com/example-org/app and https://fabric.example/app/projects/p?tab=stories.",
				chat,
			),
		),
		[
			"github.com/example-org/app",
			"fabric.example/app/projects/p?tab=stories",
		],
	);
	assert.deepEqual(
		plain(
			addresses.unverified(
				"Open features: F-12 and F-13. See README.md",
				chat,
			),
		),
		[],
		"text without a web address is never refused",
	);
});

test("a Fabric address restated without its scheme, in another case or with a trailing slash is the same address", () => {
	const addresses = new ParlumeVoiceAddresses();
	addresses.noteResult("Board: https://www.example.com/app/board.");

	assert.deepEqual(
		plain(
			addresses.unverified(
				"Board: example.com/app/board/ (also HTTPS://Example.com/app/board)",
				[],
			),
		),
		[],
	);
});

test("library names, file names and email addresses are not taken for web addresses", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(
			addresses.unverified(
				"Built with Node.js/React and ASP.NET Core; see config.ts, README.md, e.g. deploy.sh. Mail dev@example.com.",
				[],
			),
		),
		[],
	);
});

test("a bare host is an address even without a path", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(
			addresses.unverified(
				"Sign up at example.com. Docs: docs.example.io",
				[],
			),
		),
		["example.com", "docs.example.io"],
	);
});

test("a host with a path is an address in either case, on a web or a private top-level domain", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(
			addresses.unverified(
				"See EXAMPLE.COM/app and Docs.Example.IO/start. Open fabric.internal/app/F-12 or portal.corp:8443/board",
				[],
			),
		),
		[
			"example.com/app",
			"docs.example.io/start",
			"fabric.internal/app/f-12",
			"portal.corp:8443/board",
		],
	);
});

test("a second top-level domain, a port or a query belongs to the host", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(
			addresses.unverified(
				"Visit example.co.uk, example.com:8080 and example.com?ref=chat.",
				[],
			),
		),
		["example.co.uk", "example.com:8080", "example.com?ref=chat"],
	);
});

test("library names stay out even with a path after them", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(addresses.unverified("Node.js/React and Vue.JS/Nuxt", [])),
		[],
	);
});

// "React.memo/useMemo" once refused the realtime voice's whole post.
test("code names with a slash are not taken for web addresses, and real addresses still are", () => {
	const addresses = new ParlumeVoiceAddresses();

	assert.deepEqual(
		plain(
			addresses.unverified(
				"Wrap it in React.memo/useMemo, read it with lodash.get/set, use Math.PI/2 and Array.of/from; next.js renders it.",
				[],
			),
		),
		[],
	);
	assert.deepEqual(
		plain(
			addresses.unverified(
				"Docs: example.io/start, EXAMPLE.ORG/guide and https://example.dev/app",
				[],
			),
		),
		["example.io/start", "example.org/guide", "example.dev/app"],
	);
});

test("the addresses Fabric gave survive a restart, the latest 200 kept", () => {
	const addresses = new ParlumeVoiceAddresses();
	for (let index = 0; index < 205; index++) {
		addresses.noteResult(`https://example.com/F-${index}`);
	}
	const known = addresses.known();
	assert.equal(known.length, 200);
	assert.equal(known[0], "example.com/f-5");

	const restored = new ParlumeVoiceAddresses(known);
	assert.deepEqual(
		plain(
			restored.unverified(
				"https://example.com/F-204 and example.com/F-4",
				[],
			),
		),
		["example.com/f-4"],
	);
});
