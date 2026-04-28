# Tech Debt Ledger

Single source of truth for things we knowingly defer on Ironforge. When we ship something less-than-ideal (work around a bug, defer a refactor, accept a limitation), the entry lives here — not in commit messages, not in chat history, not in unwritten memory.

## How to use

When deferring something:

1. Add an entry to **Open** below under the relevant category (or create a new category).
2. Reference the entry from the inline code comment at the deferral site, e.g. `# See docs/tech-debt.md § "GSI hash_key / range_key deprecation".`
3. When the work is done, delete the entry and the inline reference.

## Entry format

Each entry has:

- **What** — one-line summary of the issue.
- **Why deferred** — why we shipped it as-is instead of fixing now.
- **When to revisit** — concrete trigger (date, milestone, condition).
- **Action** — what to do when revisiting.
- **Where** — code location(s) affected.

---

## Open

### Terraform / AWS provider

#### GSI `hash_key` / `range_key` deprecation

- **What:** `hash_key` and `range_key` arguments on `global_secondary_index` blocks in `aws_dynamodb_table` are deprecated in AWS provider 6.x.
- **Why deferred:** Pinned to AWS provider `~> 5.70` (5.x line). At apply time on the pinned provider the warning doesn't appear; replacement syntax is unverified against current docs.
- **When to revisit:** Next AWS provider major version bump (5.x → 6.x), or when adding a new GSI to the table — whichever comes first.
- **Action:** Verify the 6.x replacement syntax against AWS provider docs (likely `partition_key`/`sort_key` or a `key_schema` nested block matching the AWS API shape), update the `global_secondary_index` block, confirm via `terraform plan` that the only diff is the syntax change.
- **Where:** `infra/modules/dynamodb/main.tf` (GSI1 definition).
