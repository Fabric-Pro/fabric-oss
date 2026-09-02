---
"fabric-app": patch
---

A project's owner can be assigned as a decision owner again — the membership check no longer rejects the creator, who has no membership row.

Fizzy #2029 staging finding. `getProjectMembers` synthesizes the project creator/owner into the roster and never requires a `ProjectMember` row for them, but the decision-owner guard only queried that table with `acceptedAt: { not: null }`. Result on staging: the Owner picker offered the project owner (correctly, since it reads the roster) and the save then failed with "The owner must be a member of this project". The guard now accepts the creator/owner directly, keeping the accepted-and-unexpired rule for everyone else.
