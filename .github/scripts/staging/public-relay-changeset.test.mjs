import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPublicRelayBatch } from "./public-relay-changeset.mjs";

const privatePr = 11;
const privateHead = "a".repeat(40);
const head = "b".repeat(40);
const base = "c".repeat(40);
const repository = "Fabric-Pro/fabric-oss";
const number = 22;
const branch = `relay/staging-pr-${privatePr}-${privateHead.slice(0, 12)}-${base.slice(0, 12)}`;

const relayPr = {
	number,
	state: "open",
	merged: false,
	draft: false,
	user: { type: "Bot", login: "example-relay[bot]" },
	head: { ref: branch, sha: head, repo: { full_name: repository } },
	base: { ref: "master", sha: base, repo: { full_name: repository } },
	body: `Automated corporate relay of an authorized internal change.\n\nRelay-ID: ${head}`,
};

const valid = () => ({
	eventName: "pull_request",
	repository,
	enabled: "true",
	botLogin: "example-relay[bot]",
	eventPR: structuredClone(relayPr),
	livePR: structuredClone(relayPr),
});

test("only the exact current authenticated public relay batch uses consumed metadata", () => {
	assert.equal(classifyPublicRelayBatch(valid()), true);
	const mutations = [
		(value) => {
			value.enabled = "";
		},
		(value) => {
			value.botLogin = "";
		},
		(value) => {
			value.repository = "Fabric-Pro/fabric-dev";
		},
		(value) => {
			value.eventName = "workflow_dispatch";
		},
		(value) => {
			value.livePR = null;
		},
		(value) => {
			value.livePR.user.type = "User";
		},
		(value) => {
			value.livePR.user.login = "example-user";
		},
		(value) => {
			value.livePR.head.repo.full_name = "example/fork";
		},
		(value) => {
			value.livePR.base.repo.full_name = "example/other";
		},
		(value) => {
			value.livePR.base.ref = "staging";
		},
		(value) => {
			value.livePR.head.ref = "relay/staging-pr-0-bad";
		},
		(value) => {
			value.livePR.head.sha = "d".repeat(40);
		},
		(value) => {
			value.livePR.base.sha = "d".repeat(40);
		},
		(value) => {
			value.livePR.body = `Automated corporate relay of an authorized internal change.\n\nRelay-ID: ${"d".repeat(40)}`;
		},
		(value) => {
			value.livePR.number = 23;
		},
		(value) => {
			value.livePR.state = "closed";
		},
	];
	for (const mutate of mutations) {
		const value = valid();
		mutate(value);
		assert.equal(classifyPublicRelayBatch(value), false, mutate.toString());
	}
});
