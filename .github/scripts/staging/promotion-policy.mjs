import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PRODUCT_REPOSITORY = "Fabric-Pro/fabric-dev";
const OID = /^[0-9a-f]{40}$/u;
const PROMOTION = /^promotion\/[a-z0-9][a-z0-9-]{0,62}$/u;

export function classifyPromotion({
	eventName,
	repository,
	enabled,
	botLogin,
	eventPR,
	livePR,
}) {
	if (
		!["pull_request", "pull_request_target"].includes(eventName) ||
		repository !== PRODUCT_REPOSITORY ||
		enabled !== "true" ||
		!/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/u.test(botLogin ?? "") ||
		!eventPR ||
		!livePR ||
		!Number.isSafeInteger(eventPR.number) ||
		eventPR.number !== livePR.number
	) {
		return false;
	}
	for (const pr of [eventPR, livePR]) {
		if (
			pr.state !== "open" ||
			pr.merged === true ||
			pr.draft === true ||
			pr.user?.type !== "Bot" ||
			pr.user.login !== botLogin ||
			pr.head?.repo?.full_name !== repository ||
			pr.base?.repo?.full_name !== repository ||
			pr.base.ref !== "master" ||
			!PROMOTION.test(pr.head.ref ?? "") ||
			!OID.test(pr.head.sha ?? "")
		) {
			return false;
		}
	}
	return (
		eventPR.head.sha === livePR.head.sha &&
		eventPR.head.ref === livePR.head.ref
	);
}

async function main() {
	let reduced = false;
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
			reduced = classifyPromotion({
				eventName: process.env.GITHUB_EVENT_NAME,
				repository: process.env.GITHUB_REPOSITORY,
				enabled: process.env.STAGING_RELEASE_ENABLED,
				botLogin: process.env.PROMOTION_BOT_LOGIN,
				eventPR,
				livePR: await response.json(),
			});
		}
	} catch {
		// No authenticated decision means existing full CI, never reduced checks.
		console.error(
			"Promotion identity unavailable; retaining full private CI.",
		);
	}
	appendFileSync(process.env.GITHUB_OUTPUT, `reduced=${reduced}\n`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
