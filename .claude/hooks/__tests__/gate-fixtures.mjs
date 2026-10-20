/** Commands that the pr-quality-gate must gate through its `gh api` rule. */
export const GATED_GH_API_COMMANDS = [
	"gh api -X POST repos/o/r/pulls --input body.json",
	`jq -n '{title:"t"}' | gh api repos/o/r/pulls --input -`,
	"gh api repos/o/r/pulls -f title=t -f head=x -f base=staging",
	"gh api --method=POST /repos/{owner}/{repo}/pulls -f title=t",
	"timeout 60 gh api -X POST repos/o/r/pulls --input -",
	"gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
	"GH_TOKEN=x gh api -XPOST repos/o/r/pulls -fbase=staging",
	"cd /tmp && gh api --method POST repos/o/r/pulls?x=1 --input -",
	"bash -c 'gh api -X POST repos/o/r/pulls --input -'",
	"gh api -X=POST repos/o/r/pulls --input -",
	"gh api graphql --input payload.json",
	"gh api graphql --input -",
	"gh api graphql -F query=@q.graphql",
	"gh\tapi -X POST repos/o/r/pulls --input -",
	"gh  api -X POST repos/o/r/pulls --input -",
	"gh \\\napi -X POST repos/o/r/pulls --input -",
];

/**
 * Commands that run the PR-opening helper, which creates the PR through an
 * internal `gh api` call the gate cannot see (Fizzy #3110).
 */
export const GATED_OPEN_PR_COMMANDS = [
	"~/bin/open-pr.sh --title t --body-file body.md",
	"open-pr.sh --body-file b.md --title t --label skip-changeset",
	"bash ~/bin/open-pr.sh --title t --body-file b.md",
	"timeout 120 ./open-pr.sh --title t --body-file b.md",
	"read -r n url < <(~/bin/open-pr.sh --title t --body-file b.md)",
	'out=$(~/bin/open-pr.sh --title t --body-file b.md) && echo "$out"',
	'url="$(~/bin/open-pr.sh --title t --body-file b.md)"',
	"cd /tmp && GH_TOKEN=x open-pr.sh --title t --body-file b.md",
	"bash -c '~/bin/open-pr.sh --title t --body-file b.md'",
	"bash -lc '~/bin/open-pr.sh --title t --body-file b.md'",
	"if ! ~/bin/open-pr.sh --title t --body-file b.md; then echo failed; fi",
	"( ~/bin/open-pr.sh --title t --body-file b.md )",
	"{ ~/bin/open-pr.sh --title t --body-file b.md; }",
	"env -C /tmp ~/bin/open-pr.sh --title t --body-file b.md",
	"timeout --signal TERM 120 ~/bin/open-pr.sh --title t --body-file b.md",
	'"$HOME/bin/open-pr.sh" --title "fix: t" --body-file b.md',
	"~/bin/open-pr.sh \\\n  --title t \\\n  --body-file b.md",
	'set -- --title t --body-file b.md; ~/bin/open-pr.sh "$@"',
	'~/bin/open-pr.sh --head "$(\n  git branch --show-current\n)" --title t --body-file b.md',
	'h=~/bin/open-pr.sh; "$h" --title t --body-file b.md',
	"true;open-pr.sh --title t --body-file b.md",
	"true&&open-pr.sh --title t --body-file b.md",
	"true||open-pr.sh --title t --body-file b.md",
];
