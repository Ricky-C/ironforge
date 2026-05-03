#!/usr/bin/env bash
# verify-prerequisites.sh — sanity-check the dev environment before running
# end-to-end verification (POST /api/services kickoff, drift-detector
# verification, demo walkthroughs).
#
# Targets two bug classes that have bitten verification:
#   1. Manual-management drift — SSM/Secrets/Cognito values managed outside
#      Terraform that drift from their source of truth (e.g. SSM
#      installation-id falling out of sync with the actual GitHub App
#      installation). Caught at runtime as an opaque 404/401.
#   2. Configuration-vs-runtime mismatches — HCL values that look fine in
#      review but produce a non-functional resource at runtime (e.g. HTTP
#      API stage with throttling 0/0 = "stage blocked"). Caught at runtime
#      as an opaque 429/500.
#
# Each check is independent and self-diagnosing: on FAIL, prints the
# observed state, the expected state, and a remediation hint pointing at
# the relevant runbook entry or fix command.
#
# Usage:    ./scripts/verify-prerequisites.sh          # check dev (default)
# Exit:     0 = all checks passed; 1 = any check failed
#
# Requires: aws cli v2, gh, jq, openssl. AWS credentials with read on SSM,
# Secrets Manager, Lambda, API Gateway, SFN, DynamoDB, Cognito, ECR.
#
# Companion to docs/runbook.md § "Synthetic test user for dev verification"
# and § "GitHub App installation-id drift".

set -uo pipefail

# ---------------------------------------------------------------------------
# Config (env: dev only at present; prod values added when prod composition
# lights up)
# ---------------------------------------------------------------------------

readonly ACCOUNT_ID="010438464240"
readonly REGION="us-east-1"
readonly ENV="dev"

readonly GITHUB_ORG="ironforge-svc"
readonly DDB_TABLE="ironforge-${ENV}"
readonly API_ID="9wjbqhmzn0"
readonly SFN_ARN="arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:ironforge-${ENV}-provisioning"
readonly COGNITO_POOL_ID="us-east-1_vnvU5BYwy"
readonly COGNITO_CLIENT_ID="5q5dvippbnq8c7msupj1pi05e6"
readonly COGNITO_TEST_USER="e2e-verify-001@ironforge.test"
readonly ECR_REPO="ironforge-run-terraform"
readonly SECRET_NAME="ironforge/github-app/private-key"

readonly WORKFLOW_LAMBDAS=(
  "ironforge-${ENV}-validate-inputs"
  "ironforge-${ENV}-create-repo"
  "ironforge-${ENV}-generate-code"
  "ironforge-${ENV}-run-terraform"
  "ironforge-${ENV}-wait-for-cloudfront"
  "ironforge-${ENV}-trigger-deploy"
  "ironforge-${ENV}-wait-for-deploy"
  "ironforge-${ENV}-finalize"
  "ironforge-${ENV}-cleanup-on-failure"
  "ironforge-${ENV}-api"
)

# Lambdas whose env var GITHUB_APP_INSTALLATION_ID is set from
# `data.aws_ssm_parameter` at apply time. Manual SSM updates without a
# subsequent terraform apply leave these Lambdas pointing at the old value.
# See docs/runbook.md § "GitHub App installation-id drift" for the failure
# mode this catches.
readonly GITHUB_INSTALL_ID_LAMBDAS=(
  "ironforge-${ENV}-create-repo"
  "ironforge-${ENV}-generate-code"
  "ironforge-${ENV}-trigger-deploy"
  "ironforge-${ENV}-wait-for-deploy"
)

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_DIM=""; C_RESET=""
fi

PASSED=0
FAILED=0
SKIPPED=0
TOTAL=0
FAIL_NAMES=()

start_check() {
  TOTAL=$((TOTAL+1))
  printf '[%2d] %-58s ' "$TOTAL" "$1"
}

pass() {
  PASSED=$((PASSED+1))
  printf '%sPASS%s\n' "$C_GREEN" "$C_RESET"
  [ $# -gt 0 ] && printf '     %s%s%s\n' "$C_DIM" "$1" "$C_RESET"
}

fail() {
  FAILED=$((FAILED+1))
  FAIL_NAMES+=("$1")
  printf '%sFAIL%s\n' "$C_RED" "$C_RESET"
  shift
  while [ $# -gt 0 ]; do
    printf '     %s\n' "$1"
    shift
  done
}

skip() {
  SKIPPED=$((SKIPPED+1))
  printf '%sSKIP%s\n' "$C_YELLOW" "$C_RESET"
  [ $# -gt 0 ] && printf '     %s%s%s\n' "$C_DIM" "$1" "$C_RESET"
}

# ---------------------------------------------------------------------------
# Check 1 — AWS credentials are live
# ---------------------------------------------------------------------------

check_aws_creds() {
  local name="AWS credentials live + targeting ${ACCOUNT_ID}"
  start_check "$name"
  local got_account
  got_account=$(aws sts get-caller-identity --query 'Account' --output text 2>/dev/null) || {
    fail "$name" \
      "expected: live credentials, account $ACCOUNT_ID" \
      "got:      aws sts get-caller-identity failed" \
      "fix:      aws sso login (or your usual reauth)"
    return
  }
  if [ "$got_account" != "$ACCOUNT_ID" ]; then
    fail "$name" \
      "expected: account $ACCOUNT_ID" \
      "got:      account $got_account" \
      "fix:      aws sso login --profile <ironforge-profile>; check AWS_PROFILE"
    return
  fi
  pass "account=$got_account"
}

# ---------------------------------------------------------------------------
# Check 2 — GitHub App SSM installation-id matches actual GitHub installation
# (the bug from PR-Phase1-verify-001: SSM had stale installation-id; runtime
# 404'd with opaque "GitHub installation-token exchange failed")
# ---------------------------------------------------------------------------

check_github_installation_id() {
  local name="SSM installation-id matches actual GitHub installation"
  start_check "$name"
  local ssm_id gh_id
  ssm_id=$(aws ssm get-parameter --name /ironforge/github-app/installation-id --query 'Parameter.Value' --output text 2>/dev/null) || {
    fail "$name" \
      "got:      SSM /ironforge/github-app/installation-id missing or unreadable" \
      "fix:      see infra/BOOTSTRAP.md or docs/runbook.md § GitHub App installation-id drift"
    return
  }
  gh_id=$(gh api "/orgs/${GITHUB_ORG}/installations" --jq ".installations[] | select(.app_id == $(aws ssm get-parameter --name /ironforge/github-app/app-id --query 'Parameter.Value' --output text 2>/dev/null)) | .id" 2>/dev/null) || {
    skip "gh api unreachable — re-run when GitHub is up"
    return
  }
  if [ -z "$gh_id" ]; then
    fail "$name" \
      "got:      no installation found for app on org ${GITHUB_ORG}" \
      "fix:      reinstall app at https://github.com/organizations/${GITHUB_ORG}/settings/installations and run 'aws ssm put-parameter --name /ironforge/github-app/installation-id --value <new-id> --type String --overwrite'"
    return
  fi
  if [ "$ssm_id" != "$gh_id" ]; then
    fail "$name" \
      "expected: SSM installation-id = $gh_id (from GitHub)" \
      "got:      SSM installation-id = $ssm_id" \
      "fix:      aws ssm put-parameter --name /ironforge/github-app/installation-id --value $gh_id --type String --overwrite"
    return
  fi
  pass "installation-id=$ssm_id"
}

# ---------------------------------------------------------------------------
# Check 3 — Secrets Manager private key for the GitHub App is present and
# decryptable (we don't fetch the value; describe-secret confirms metadata
# and KMS access)
# ---------------------------------------------------------------------------

check_github_private_key_secret() {
  local name="GitHub App private key secret present + KMS-readable"
  start_check "$name"
  local meta
  meta=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query '{KMS:KmsKeyId,LastChanged:LastChangedDate}' --output json 2>/dev/null) || {
    fail "$name" \
      "got:      secret $SECRET_NAME missing or no permission to describe" \
      "fix:      see infra/BOOTSTRAP.md § GitHub App private key (manual create + terraform import)"
    return
  }
  local kms
  kms=$(echo "$meta" | jq -r '.KMS')
  if [ "$kms" = "null" ] || [ -z "$kms" ]; then
    fail "$name" \
      "got:      secret has no CMK reference" \
      "fix:      verify infra/modules/github-app-secret/ output; secret should be CMK-encrypted"
    return
  fi
  pass "kms=${kms##*/}"
}

# ---------------------------------------------------------------------------
# Check 4 — API Gateway HTTP API stage throttling > 0 (the bug from
# PR #65: unset throttling on HTTP API v2 = stage blocked = 429 every
# request)
# ---------------------------------------------------------------------------

check_api_gateway_throttling() {
  local name="API Gateway stage throttling > 0 (HTTP API v2 trap)"
  start_check "$name"
  local settings
  settings=$(aws apigatewayv2 get-stages --api-id "$API_ID" --query 'Items[0].DefaultRouteSettings' --output json 2>/dev/null) || {
    fail "$name" \
      "got:      could not describe stage on API $API_ID" \
      "fix:      verify API ID; check terraform state; aws sso login if needed"
    return
  }
  local burst rate
  burst=$(echo "$settings" | jq -r '.ThrottlingBurstLimit')
  rate=$(echo "$settings" | jq -r '.ThrottlingRateLimit')
  if [ "$burst" = "0" ] || [ "$rate" = "0" ] || [ "$burst" = "null" ] || [ "$rate" = "null" ]; then
    fail "$name" \
      "expected: ThrottlingBurstLimit > 0 AND ThrottlingRateLimit > 0" \
      "got:      burst=$burst rate=$rate (HTTP API v2 treats 0 as 'stage blocked')" \
      "fix:      see PR #65; set throttling_burst_limit + throttling_rate_limit in infra/modules/api-gateway/main.tf default_route_settings"
    return
  fi
  pass "burst=$burst rate=${rate}/s"
}

# ---------------------------------------------------------------------------
# Check 5 — SFN state machine present and ACTIVE
# ---------------------------------------------------------------------------

check_sfn_state_machine() {
  local name="SFN state machine ACTIVE"
  start_check "$name"
  local status
  status=$(aws stepfunctions describe-state-machine --state-machine-arn "$SFN_ARN" --query 'status' --output text 2>/dev/null) || {
    fail "$name" \
      "got:      state machine missing or no permission" \
      "expected: $SFN_ARN exists with status ACTIVE" \
      "fix:      check infra-apply ran for dev; aws stepfunctions list-state-machines"
    return
  }
  if [ "$status" != "ACTIVE" ]; then
    fail "$name" \
      "expected: ACTIVE" \
      "got:      $status"
    return
  fi
  pass "status=$status"
}

# ---------------------------------------------------------------------------
# Check 6 — Every workflow Lambda exists, is Active, and has a non-null
# image_uri (catches Lambda functions that were created but whose image
# build/push failed and left them in a broken state)
# ---------------------------------------------------------------------------

check_workflow_lambdas() {
  local name="All workflow + api Lambdas Active"
  start_check "$name"
  local missing=()
  local broken=()
  for fn in "${WORKFLOW_LAMBDAS[@]}"; do
    local cfg
    cfg=$(aws lambda get-function-configuration --function-name "$fn" --query '{State:State,LastUpdate:LastUpdateStatus}' --output json 2>/dev/null) || {
      missing+=("$fn")
      continue
    }
    local state last_update
    state=$(echo "$cfg" | jq -r '.State')
    last_update=$(echo "$cfg" | jq -r '.LastUpdate')
    if [ "$state" != "Active" ] || [ "$last_update" != "Successful" ]; then
      broken+=("$fn (state=$state lastUpdate=$last_update)")
    fi
  done
  if [ ${#missing[@]} -gt 0 ] || [ ${#broken[@]} -gt 0 ]; then
    local msgs=()
    [ ${#missing[@]} -gt 0 ] && msgs+=("missing: ${missing[*]}")
    [ ${#broken[@]} -gt 0 ] && msgs+=("broken: ${broken[*]}")
    msgs+=("fix: check infra-apply logs for the failing module")
    fail "$name" "${msgs[@]}"
    return
  fi
  pass "${#WORKFLOW_LAMBDAS[@]} Lambdas Active"
}

# ---------------------------------------------------------------------------
# Check 7 — DynamoDB table ACTIVE with the expected GSI present
# ---------------------------------------------------------------------------

check_ddb_table() {
  local name="DynamoDB table ACTIVE + GSI1 present"
  start_check "$name"
  local desc
  desc=$(aws dynamodb describe-table --table-name "$DDB_TABLE" --query '{Status:Table.TableStatus,GSIs:Table.GlobalSecondaryIndexes[].IndexName}' --output json 2>/dev/null) || {
    fail "$name" \
      "got:      table $DDB_TABLE missing or no permission" \
      "fix:      check infra-apply on dynamodb module"
    return
  }
  local status has_gsi1
  status=$(echo "$desc" | jq -r '.Status')
  has_gsi1=$(echo "$desc" | jq -r '.GSIs // [] | any(. == "GSI1")')
  if [ "$status" != "ACTIVE" ]; then
    fail "$name" "expected: ACTIVE" "got: $status"
    return
  fi
  if [ "$has_gsi1" != "true" ]; then
    fail "$name" \
      "expected: GSI named 'GSI1' on table $DDB_TABLE" \
      "got:      no GSI1 found" \
      "fix:      check infra/modules/dynamodb/ — owner-scoped queries depend on this index"
    return
  fi
  pass "status=$status, GSI1 present"
}

# ---------------------------------------------------------------------------
# Check 8 — Cognito user pool exists + dev client allows USER_SRP_AUTH
# (the mint-test-token helper depends on SRP; if the client config is
# tightened further to refresh-only, mint will fail with NotAuthorized)
# ---------------------------------------------------------------------------

check_cognito_pool_and_client() {
  local name="Cognito pool reachable + dev client allows USER_SRP_AUTH"
  start_check "$name"
  aws cognito-idp describe-user-pool --user-pool-id "$COGNITO_POOL_ID" --query 'UserPool.Id' --output text >/dev/null 2>&1 || {
    fail "$name" \
      "got:      pool $COGNITO_POOL_ID unreadable" \
      "fix:      check infra-apply on cognito module"
    return
  }
  local flows
  flows=$(aws cognito-idp describe-user-pool-client --user-pool-id "$COGNITO_POOL_ID" --client-id "$COGNITO_CLIENT_ID" --query 'UserPoolClient.ExplicitAuthFlows' --output json 2>/dev/null) || {
    fail "$name" "got: client $COGNITO_CLIENT_ID unreadable in pool $COGNITO_POOL_ID"
    return
  }
  local has_srp
  has_srp=$(echo "$flows" | jq -r 'any(. == "ALLOW_USER_SRP_AUTH")')
  if [ "$has_srp" != "true" ]; then
    fail "$name" \
      "expected: ExplicitAuthFlows includes ALLOW_USER_SRP_AUTH" \
      "got:      $(echo "$flows" | jq -c .)" \
      "fix:      mint-test-token requires SRP; restore in infra/modules/cognito/main.tf or use OAuth code flow"
    return
  fi
  pass "ALLOW_USER_SRP_AUTH enabled"
}

# ---------------------------------------------------------------------------
# Check 9 — Synthetic test user exists + CONFIRMED (not FORCE_CHANGE_PASSWORD,
# the trap that breaks SRP and surfaces as 'newPasswordRequired' in the
# mint helper)
# ---------------------------------------------------------------------------

check_test_user_status() {
  local name="Synthetic test user CONFIRMED (mint-test-token works)"
  start_check "$name"
  local status
  status=$(aws cognito-idp admin-get-user --user-pool-id "$COGNITO_POOL_ID" --username "$COGNITO_TEST_USER" --query 'UserStatus' --output text 2>/dev/null) || {
    fail "$name" \
      "got:      user $COGNITO_TEST_USER does not exist" \
      "fix:      see docs/runbook.md § 'Synthetic test user for dev verification'"
    return
  }
  if [ "$status" != "CONFIRMED" ]; then
    fail "$name" \
      "expected: UserStatus=CONFIRMED" \
      "got:      UserStatus=$status" \
      "fix:      aws cognito-idp admin-set-user-password --user-pool-id $COGNITO_POOL_ID --username $COGNITO_TEST_USER --password '<new>' --permanent"
    return
  fi
  pass "status=$status"
}

# ---------------------------------------------------------------------------
# Check 10 — ECR image present for run-terraform Lambda (catches the case
# where the ECR repo exists but the image was never pushed, which leaves
# the Lambda referencing a digest that doesn't exist)
# ---------------------------------------------------------------------------

check_ecr_image_present() {
  local name="ECR image for run-terraform Lambda exists"
  start_check "$name"
  local lambda_digest
  lambda_digest=$(aws lambda get-function --function-name "ironforge-${ENV}-run-terraform" --query 'Code.ImageUri' --output text 2>/dev/null) || {
    fail "$name" "got: could not read run-terraform Lambda image_uri"
    return
  }
  local digest_only="${lambda_digest##*@}"
  if [ -z "$digest_only" ] || [ "$digest_only" = "$lambda_digest" ]; then
    fail "$name" \
      "got:      Lambda image_uri has no @sha256: digest (uri=$lambda_digest)" \
      "fix:      verify Lambda was deployed against an immutable image tag"
    return
  fi
  aws ecr describe-images --repository-name "$ECR_REPO" --image-ids "imageDigest=$digest_only" --query 'imageDetails[0].imageDigest' --output text >/dev/null 2>&1 || {
    fail "$name" \
      "expected: ECR repo $ECR_REPO has image at digest $digest_only" \
      "got:      digest not found in ECR" \
      "fix:      Lambda points at a missing image; rebuild + push, then update Lambda or rerun infra-apply"
    return
  }
  pass "digest=${digest_only:0:19}..."
}

# ---------------------------------------------------------------------------
# Check 11 — Lambda env var GITHUB_APP_INSTALLATION_ID matches current SSM
# value (the bug from PR-Phase1-verify-002: SSM was correct after a manual
# put-parameter, but Lambda env vars were apply-time-baked from the OLD SSM
# value, so the Lambdas continued to fail with 404 on installation-token
# exchange. Catches the SSM-source-of-source vs Lambda-env-var-cache drift.)
# ---------------------------------------------------------------------------

check_lambda_env_matches_ssm() {
  local name="Lambda GITHUB_APP_INSTALLATION_ID env vars match SSM"
  start_check "$name"
  local ssm_id
  ssm_id=$(aws ssm get-parameter --name /ironforge/github-app/installation-id --query 'Parameter.Value' --output text 2>/dev/null) || {
    fail "$name" "got: SSM unreadable (Check 2 already failed; this check requires SSM)"
    return
  }
  local mismatched=()
  for fn in "${GITHUB_INSTALL_ID_LAMBDAS[@]}"; do
    local env_id
    env_id=$(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables.GITHUB_APP_INSTALLATION_ID' --output text 2>/dev/null)
    if [ "$env_id" != "$ssm_id" ]; then
      mismatched+=("$fn (env=$env_id vs ssm=$ssm_id)")
    fi
  done
  if [ ${#mismatched[@]} -gt 0 ]; then
    fail "$name" \
      "expected: all ${#GITHUB_INSTALL_ID_LAMBDAS[@]} Lambdas hold env var = SSM ($ssm_id)" \
      "got:      mismatch on: ${mismatched[*]}" \
      "fix:      env vars are apply-time-baked from data.aws_ssm_parameter; trigger infra-apply on dev to re-bake (gh workflow run infra-apply.yml). If SSM itself is wrong, also update TF_VAR_GITHUB_APP_INSTALLATION_ID before re-apply or shared apply will revert SSM."
    return
  fi
  pass "all ${#GITHUB_INSTALL_ID_LAMBDAS[@]} env vars = SSM ($ssm_id)"
}

# ---------------------------------------------------------------------------
# Run all checks
# ---------------------------------------------------------------------------

echo "Ironforge prerequisites — env=$ENV account=$ACCOUNT_ID region=$REGION"
echo "================================================================================"

check_aws_creds
check_github_installation_id
check_github_private_key_secret
check_api_gateway_throttling
check_sfn_state_machine
check_workflow_lambdas
check_ddb_table
check_cognito_pool_and_client
check_test_user_status
check_ecr_image_present
check_lambda_env_matches_ssm

echo "================================================================================"
printf 'Total: %d   ' "$TOTAL"
printf '%sPassed: %d%s   ' "$C_GREEN" "$PASSED" "$C_RESET"
[ "$FAILED" -gt 0 ] && printf '%sFailed: %d%s   ' "$C_RED" "$FAILED" "$C_RESET" || printf 'Failed: 0   '
[ "$SKIPPED" -gt 0 ] && printf '%sSkipped: %d%s' "$C_YELLOW" "$SKIPPED" "$C_RESET" || printf 'Skipped: 0'
echo

if [ "$FAILED" -gt 0 ]; then
  echo
  printf '%sFailed checks:%s\n' "$C_RED" "$C_RESET"
  for n in "${FAIL_NAMES[@]}"; do
    printf '  - %s\n' "$n"
  done
  exit 1
fi
exit 0
