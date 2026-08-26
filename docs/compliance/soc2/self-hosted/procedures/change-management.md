# Change Management Procedure — TEMPLATE (self-hosted Fabric)

> Fabric-authored base template. Complete every **[CUSTOMER: …]** placeholder,
> obtain management approval, and retain change records as SOC 2 evidence.

| | |
|---|---|
| Audience | **[CUSTOMER: platform administrators, change approvers, compliance owner, and auditor]** |
| Owner | **[CUSTOMER: change owner]** |
| Approver | **[CUSTOMER: management]** |
| Version / date | v0.2 (template) / **[CUSTOMER: date]** |
| Review cadence | Annual and after a material process or provider change |
| Evidence retention | **[CUSTOMER: period aligned to the audit observation window]** |

## 1. Purpose and scope

This procedure governs changes to a self-hosted Fabric deployment: Fabric
release upgrades, Helm/Terraform configuration, infrastructure, database
migrations, CI/CD configuration, and emergency changes. It provides a
repository-agnostic baseline that a customer implements with controls native to
its source-control and CI/CD provider.

This guidance supports a customer's CC8.1 change-control design. It does not
certify an environment or guarantee auditor acceptance. Customer management and
its auditor decide the reviewer qualifications, approval count, segregation of
duties, retention period, and observation window.

## 2. Change types

- **Standard** — a documented, pre-approved, low-risk change such as scaling a
  replica count. Log each use and periodically review the standard-change list.
- **Normal** — reviewed, tested, and approved before it is applied.
- **Emergency** — expedited to address an active incident, using restricted
  break-glass authority and retrospective independent review.

## 3. Two separate control layers

### 3.1 Independent merge review

Merge approval authorizes source to enter a protected release branch. Configure
the provider so that:

1. Production-bound changes enter the branch only through a pull/merge request.
2. At least one authorized approver is independent of the author; the author or
   latest pusher cannot be the only qualifying approver.
3. Material new commits dismiss or re-evaluate earlier approvals.
4. Required build, test, security, and policy checks pass, and review
   conversations are resolved.
5. Direct pushes, force pushes, branch deletion, and broad bypass are blocked.
   Any exception is limited to named, least-privileged, monitored break-glass
   actors and receives retrospective independent review.

Use the branch name, reviewer group, and approval count selected by
**[CUSTOMER]**. There is no universal SOC 2 requirement for a reviewer with a
particular job title.

### 3.2 Optional production-promotion approval

Production approval authorizes a specific tested artifact for a specific
environment and time. **Fabric examples leave this gate off by default**, so a
customer that does not configure it retains automatic promotion. If **[CUSTOMER]**
enables it, configure the provider so that:

1. The deploy job targets a provider-managed `production` environment/resource.
2. Production credentials and protected variables are unavailable until the
   environment approval and checks succeed.
3. An authorized person who did not trigger the deployment approves it.
4. The decision identifies an immutable artifact, such as an image digest or a
   release/tag plus commit SHA; a mutable tag alone is insufficient evidence.
5. Deployment branch/tag restrictions limit which artifacts can reach production.
6. Bypass is disabled or restricted to named, monitored emergency actors.

Disabling an enabled promotion gate is itself a controlled policy change. Merge
approval and promotion approval do not replace required automated checks, and
automated or AI review is supplemental rather than independent human approval.

### 3.3 Enforcement boundary

Repository and environment policies live in the customer's SCM/CI provider
control plane. Workflow YAML can reference a protected environment, but that
reference alone does not create an approval rule. Helm and Terraform receive an
already-authorized artifact; they cannot establish reviewer identity, block an
unreviewed merge, or protect provider-held deployment credentials. The Fabric
chart and modules therefore deliberately expose no code-review or approval flag.

## 4. Provider setup recipes

Provider features and plan/tier availability change. Confirm the controls are
available for **[CUSTOMER]**'s account and repository before adopting this
template, and retain evidence of the effective provider configuration.

### 4.1 GitHub

**Repository settings (outside the repository):**

- Apply a branch ruleset or branch protection to the release branch. Require a
  pull request and at least one approval, required CI/security checks, and
  resolved conversations.
- Dismiss stale approvals or require approval of the most recent reviewable push.
  Configure last-pusher/self-approval behavior to preserve independence.
- Block force pushes and deletion. Remove broad ruleset bypasses or restrict them
  to the documented break-glass role.

**Optional workflow hook:** the production job references the environment:

```yaml
jobs:
  deploy-production:
    environment: production
```

**Environment settings (outside the repository):** add required reviewers,
enable prevent-self-review, restrict deployment branches/tags, decide whether
administrators may bypass, and store production credentials only in the protected
environment. See GitHub's [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
and [deployment protection guidance](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments).

### 4.2 GitLab

**Project/group settings (outside the repository):**

- Protect the release branch, require merge requests and the customer-selected
  approval count, prevent author approval and approval-rule overrides, and reset
  or re-evaluate approvals after new commits.
- Require pipelines/security jobs and resolved discussions. Restrict push,
  force-push, merge, and bypass permissions.

**Optional pipeline hook:** a deploy job declares `environment: name: production`.
The shipped `ci/gitlab/60-deploy-aws.yml` contains that declaration, but
`deploy:aws:prod` remains `when: never` until its separate DEV/PROD variable
isolation prerequisite is fixed.

**Environment settings (outside the repository):** protect `production`, define
deployment approval rules, restrict allowed deployers, and expose protected
credentials only after approval. A `when: manual` job by itself does not prove
independent approval. Required approvals and protected-environment features may
require GitLab Premium or Ultimate. See GitLab's [merge request approvals](https://docs.gitlab.com/user/project/merge_requests/approvals/),
[approval rules](https://docs.gitlab.com/user/project/merge_requests/approvals/rules/),
[protected branches](https://docs.gitlab.com/user/project/repository/branches/protected/),
[protected environments](https://docs.gitlab.com/ci/environments/protected_environments/),
and [deployment approvals](https://docs.gitlab.com/ci/environments/deployment_approvals/).

### 4.3 Azure DevOps

**Repository settings (outside the repository):** configure branch policies for
minimum reviewers, author/self-approval behavior, required reviewers where the
ownership model calls for them, comment resolution, build validation, required
status checks, and limited policy-bypass permissions.

**Optional pipeline hook:** target a production environment/resource from the
deployment job.

**Environment settings (outside pipeline YAML):** a resource administrator adds
an approver group, prevents self-approval, applies branch control, and uses an
exclusive lock where concurrent promotion is unsafe. Azure Pipelines approvals
and checks are administered on the protected resource, so a pipeline author
cannot remove them from a run by editing YAML. See Azure DevOps
[branch policies](https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies?view=azure-devops),
[approvals and checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals?view=azure-devops),
and [CI/CD governance](https://learn.microsoft.com/en-us/devops/operate/governance-cicd).

## 5. Normal change procedure

1. **Request** — record the identifier, purpose, owner, risk, schedule, test plan,
   and rollback plan. **[CUSTOMER]**
2. **Review source** — use the protected-branch control; retain the PR/MR link,
   author, independent approver, approval timestamp, final commit, required check
   results, resolved conversations, and any approved exception.
3. **Test** — deploy to a non-production cluster/namespace and record the result.
4. **Identify artifact** — record the immutable image digest or release/tag plus
   commit SHA that passed testing.
5. **Authorize promotion** — when the optional gate is enabled, retain the
   production approver, decision, and timestamp for that artifact.
6. **Apply** — run the approved `terraform apply`, `helm upgrade`, and/or migration.
7. **Verify** — record deployment results, health checks, smoke tests, and relevant
   audit-log or monitoring evidence.
8. **Close or roll back** — record the outcome and, if necessary, restore the
   previous chart revision/artifact or execute the approved infrastructure/data
   recovery plan.

## 6. Emergency change procedure

1. Link the change to the active incident and record why normal prior approval
   was not possible.
2. Limit bypass to the named break-glass actor; record the actor, time, scope, and
   justification in provider and incident logs.
3. Test as far as the incident permits, deploy one identified artifact, and
   perform verification or rollback.
4. Obtain and retain retrospective independent approval, including review of the
   bypass and outcome, within **[CUSTOMER: emergency-review SLA]**.

## 7. Evidence to retain

For the period selected by **[CUSTOMER]**, retain:

- dated screenshots, exports, or API responses for the effective protected-
  branch/ruleset and protected-environment configuration;
- reviewer/deployer group membership and all configured bypass actors;
- the complete population of normal-change records containing every field in
  section 5; and
- the complete population of emergency records containing every field in
  section 6.

A committed workflow file is not evidence of settings stored in the provider
control plane. Re-capture configuration evidence after a material policy change
and periodically throughout the audit observation window. The auditor selects
samples from the retained complete population; the customer must not discard
unsampled changes.
