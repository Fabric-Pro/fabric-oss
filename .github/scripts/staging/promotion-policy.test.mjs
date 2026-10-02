import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPromotion } from "./promotion-policy.mjs";

const sha = "a".repeat(40);
const pr = {
	number: 11,
	state: "open",
	merged: false,
	draft: false,
	user: { type: "Bot", login: "example-release[bot]" },
	base: { ref: "master", repo: { full_name: "Fabric-Pro/fabric-dev" } },
	head: {
		ref: "promotion/example-cycle",
		sha,
		repo: { full_name: "Fabric-Pro/fabric-dev" },
	},
};
const valid = () => ({
	eventName: "pull_request",
	repository: "Fabric-Pro/fabric-dev",
	enabled: "true",
	botLogin: "example-release[bot]",
	eventPR: structuredClone(pr),
	livePR: structuredClone(pr),
});

test("only exact live authenticated private promotion opts into reduced checks", () => {
	assert.equal(classifyPromotion(valid()), true);
	const mutations = [
		(v) => {
			v.eventName = "workflow_dispatch";
		},
		(v) => {
			v.enabled = "";
		},
		(v) => {
			v.botLogin = "";
		},
		(v) => {
			v.repository = "example/public";
		},
		(v) => {
			v.livePR = null;
		},
		(v) => {
			v.livePR.user.type = "User";
		},
		(v) => {
			v.livePR.user.login = "example-user";
		},
		(v) => {
			v.livePR.head.repo.full_name = "example/fork";
		},
		(v) => {
			v.livePR.base.repo.full_name = "example/other";
		},
		(v) => {
			v.livePR.base.ref = "staging";
		},
		(v) => {
			v.livePR.head.ref = "feature/example";
		},
		(v) => {
			v.livePR.head.sha = "b".repeat(40);
		},
		(v) => {
			v.eventPR.head.sha = "invalid";
		},
		(v) => {
			v.livePR.number = 12;
		},
		(v) => {
			v.livePR.state = "closed";
		},
	];
	for (const mutate of mutations) {
		const value = valid();
		mutate(value);
		assert.equal(classifyPromotion(value), false, mutate.toString());
	}
});
