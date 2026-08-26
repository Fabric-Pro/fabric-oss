# GitLab CI

Connecting a GitLab project so Fabric can read pipeline results and start runs.

- **Audience**: engineers working on the QA surface; support engineers diagnosing a project whose pipeline results look wrong
- **Owner**: Fabric platform team

## Credential and scope

| Capability | Scope |
|---|---|
| Read results | `read_api` |
| Start a run | `api` |

`read_api` is the trap here. It reads pipelines perfectly well, so ingestion
works and the connection looks healthy, but it **cannot create one** — the
trigger fails while everything else succeeds. A team that wants the *Run tests*
button needs `api`.

## What the customer must change

Nothing. GitLab runs a **ref** rather than a named definition, reading whatever
`.gitlab-ci.yml` exists there, so there is no pipeline to pick and no file to
edit.

That difference is modelled as a discriminated union in `ci-trigger-dispatch.ts`
rather than an optional field: a GitHub trigger cannot be constructed without a
workflow id, and a GitLab trigger cannot carry one.

Test results need `artifacts:reports:junit` in the job definition, not
`artifacts:paths`. Both upload the file; only the first registers it as test
results, and this is the usual reason a GitLab sync returns pipelines with no
tests attached. The generator in Settings ▸ Testing ▸ Sync emits the correct form.

## How a wrong scope presents

A `read_api` token returns **403 on pipeline creation** while every read
continues to work. The symptom a customer reports is "the Run tests button does
nothing useful", not "my token is wrong", so check the scope before the pipeline.

## Verifying

Read access — this should list pipelines:

```bash
curl -s -H "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/projects/<id>/pipelines?per_page=5"
```

Write access, without leaving a stray pipeline behind: confirm the token reports
the `api` scope rather than firing a test pipeline.

```bash
curl -s -H "PRIVATE-TOKEN: <token>" \
  "https://gitlab.example.com/api/v4/personal_access_tokens/self" \
  | jq '.scopes'
```
