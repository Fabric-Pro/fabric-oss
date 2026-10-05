import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PUBLIC_REPOSITORY = "Fabric-Pro/fabric-oss";
const OID = /^[0-9a-f]{40}$/u;
const RELAY_BRANCH =
	/^relay\/staging-pr-([1-9][0-9]*)-([0-9a-f]{12})-([0-9a-f]{12})$/u;

function isRelayBatchPR(pr, repository, botLogin) {
	if (
		pr?.state !== "open" ||
		pr.merged === true ||
		pr.draft === true ||
		pr.user?.type !== "Bot" ||
		pr.user.login !== botLogin ||
		pr.head?.repo?.full_name !== repository ||
		pr.base?.repo?.full_name !== repository ||
		pr.base.ref !== "master" ||
		!Number.isSafeInteger(pr.number) ||
		!OID.test(pr.head?.sha ?? "") ||
		!OID.test(pr.base?.sha ?? "")
	) {
		return false;
	}
	const branch = RELAY_BRANCH.exec(pr.head.ref ?? "");
	return (
		branch !== null &&
		Number.isSafeInteger(Number(branch[1])) &&
		Number(branch[1]) > 0 &&
		pr.base.sha.startsWith(branch[3]) &&
		pr.body ===
			`Automated corporate relay of an authorized internal change.\n\nRelay-ID: ${pr.head.sha}`
	);
}

export function classifyPublicRelayBatch({
	eventName,
	repository,
	enabled,
	botLogin,
	eventPR,
	livePR,
}) {
	if (
		eventName !== "pull_request" ||
		repository !== PUBLIC_REPOSITORY ||
		enabled !== "true" ||
		!/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/u.test(botLogin ?? "") ||
		!eventPR ||
		!livePR ||
		!isRelayBatchPR(eventPR, repository, botLogin) ||
		!isRelayBatchPR(livePR, repository, botLogin)
	) {
		return false;
	}
	return (
		eventPR.number === livePR.number &&
		eventPR.head.sha === livePR.head.sha &&
		eventPR.head.ref === livePR.head.ref &&
		eventPR.base.sha === livePR.base.sha &&
		eventPR.body === livePR.body
	);
}

async function main() {
	let relayBatch = false;
	try {
		const event = JSON.parse(
			readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
		);
		const eventPR = event.pull_request;
		if (eventPR && Number.isSafeInteger(eventPR.number)) {
			const response = await fetch(
				`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}/pulls/${eventPR.number}`,
				{
					headers: {
						Authorization: `Bearer ${process.env.GH_TOKEN}`,
						Accept: "application/vnd.github+json",
					},
					signal: AbortSignal.timeout(15000),
				},
			);
			if (!response.ok) {
				throw new Error("read failed");
			}
			relayBatch = classifyPublicRelayBatch({
				eventName: process.env.GITHUB_EVENT_NAME,
				repository: process.env.GITHUB_REPOSITORY,
				enabled: process.env.STAGING_RELEASE_ENABLED,
				botLogin: process.env.OSS_RELAY_APP_LOGIN,
				eventPR,
				livePR: await response.json(),
			});
		}
	} catch {
		console.error(
			"Public relay identity unavailable; requiring a changeset.",
		);
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `relay_batch=${relayBatch}\n`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
