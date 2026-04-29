# Ironforge Infrastructure Bootstrap

One-time, manual AWS CLI commands that create resources Terraform itself depends on. After running this once per AWS account, all subsequent infrastructure is managed by Terraform.

## What gets created

- **KMS customer-managed key** (alias `alias/ironforge-terraform-state`) — encrypts the state bucket.
- **S3 bucket** `ironforge-terraform-state-<account-id>` — Terraform remote state. Versioning enabled, default CMK encryption, all public access blocked, TLS-only bucket policy, 90-day expiration of non-current versions.
- **DynamoDB table** `ironforge-terraform-locks` — Terraform state locking. Single table shared across all environments. On-demand billing.

A second bootstrap step (GitHub Actions OIDC) lands in `OIDC_BOOTSTRAP.md` in a later commit.

## Prerequisites

- AWS CLI v2 configured with an **admin** profile for the Ironforge AWS account.
- `jq` installed (used in verification).
- Working directory: `infra/`.

Set environment variables for the session:

```bash
export AWS_PROFILE=<your-admin-profile>
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=<your-aws-account-id>
export STATE_BUCKET="ironforge-terraform-state-${AWS_ACCOUNT_ID}"
export LOCK_TABLE="ironforge-terraform-locks"
```

Verify the right account:

```bash
aws sts get-caller-identity --query Account --output text
# Should match the AWS_ACCOUNT_ID you set above.
```

## Step 1 — KMS customer-managed key

```bash
KEY_ID=$(aws kms create-key \
  --description "Ironforge Terraform state encryption" \
  --key-usage ENCRYPT_DECRYPT \
  --tags TagKey=ironforge-managed,TagValue=true \
         TagKey=ironforge-component,TagValue=terraform-state \
         TagKey=ironforge-environment,TagValue=shared \
  --query 'KeyMetadata.KeyId' --output text)

echo "Created KMS key: ${KEY_ID}"

aws kms create-alias \
  --alias-name alias/ironforge-terraform-state \
  --target-key-id "${KEY_ID}"

# Enable annual rotation. New keys do NOT have rotation enabled by default;
# this is an explicit one-line cost (~$0/year for symmetric keys) and a
# one-line follow-up command. Skip-by-default would leak into the audit trail.
aws kms enable-key-rotation --key-id "${KEY_ID}"
```

The default key policy grants full access to the account root, which delegates to IAM. Any IAM principal in the account with appropriate KMS permissions (admin or PowerUser) can use this key. The GitHub Actions OIDC role will be added to the key policy in a later step.

## Step 2 — S3 state bucket

```bash
# Create the bucket. us-east-1 does not take a LocationConstraint.
aws s3api create-bucket --bucket "${STATE_BUCKET}"

# Versioning
aws s3api put-bucket-versioning \
  --bucket "${STATE_BUCKET}" \
  --versioning-configuration Status=Enabled

# Default encryption with the CMK
aws s3api put-bucket-encryption \
  --bucket "${STATE_BUCKET}" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms",
        "KMSMasterKeyID": "alias/ironforge-terraform-state"
      },
      "BucketKeyEnabled": true
    }]
  }'

# Block all public access
aws s3api put-public-access-block \
  --bucket "${STATE_BUCKET}" \
  --public-access-block-configuration '{
    "BlockPublicAcls": true,
    "IgnorePublicAcls": true,
    "BlockPublicPolicy": true,
    "RestrictPublicBuckets": true
  }'

# TLS-only bucket policy
aws s3api put-bucket-policy --bucket "${STATE_BUCKET}" --policy "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyInsecureTransport",
    "Effect": "Deny",
    "Principal": "*",
    "Action": "s3:*",
    "Resource": [
      "arn:aws:s3:::${STATE_BUCKET}",
      "arn:aws:s3:::${STATE_BUCKET}/*"
    ],
    "Condition": {"Bool": {"aws:SecureTransport": "false"}}
  }]
}
EOF
)"

# Lifecycle: expire non-current versions after 90 days
aws s3api put-bucket-lifecycle-configuration \
  --bucket "${STATE_BUCKET}" \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "ExpireNoncurrentVersions",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": {"NoncurrentDays": 90}
    }]
  }'

# Tags
aws s3api put-bucket-tagging --bucket "${STATE_BUCKET}" --tagging '{
  "TagSet": [
    {"Key": "ironforge-managed",     "Value": "true"},
    {"Key": "ironforge-component",   "Value": "terraform-state"},
    {"Key": "ironforge-environment", "Value": "shared"}
  ]
}'
```

## Step 3 — DynamoDB lock table

```bash
aws dynamodb create-table \
  --table-name "${LOCK_TABLE}" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=terraform-state \
         Key=ironforge-environment,Value=shared

aws dynamodb wait table-exists --table-name "${LOCK_TABLE}"
```

## Verification

```bash
aws s3api get-bucket-versioning --bucket "${STATE_BUCKET}"
aws s3api get-bucket-encryption --bucket "${STATE_BUCKET}"
aws s3api get-public-access-block --bucket "${STATE_BUCKET}"
aws s3api get-bucket-policy --bucket "${STATE_BUCKET}" --query Policy --output text | jq
aws s3api get-bucket-lifecycle-configuration --bucket "${STATE_BUCKET}"
aws dynamodb describe-table --table-name "${LOCK_TABLE}" --query 'Table.TableStatus'
aws kms describe-key --key-id alias/ironforge-terraform-state --query 'KeyMetadata.KeyId'
aws kms get-key-rotation-status --key-id alias/ironforge-terraform-state --query 'KeyRotationEnabled'
```

Every command should succeed and print expected values. The rotation status command should print `True`.

## Idempotency

Run this **once**. If a step fails because a resource already exists, skip past it; do not re-run `aws kms create-key` (it would create a duplicate key, since KMS keys do not de-dupe by description).

## State key layout

Terraform state objects in this bucket use the key structure `ironforge/<env>/<component>/terraform.tfstate`. For Phase 0 there is one component per env (`platform`); the structure leaves room to split by component (e.g., `frontend`, `dns`) without restructuring the bucket.

| Key | Purpose |
|---|---|
| `ironforge/dev/platform/terraform.tfstate` | Dev environment, all platform infra |
| `ironforge/prod/platform/terraform.tfstate` | Prod environment, all platform infra |

## Next bootstrap

After this completes, set up GitHub Actions OIDC: see `OIDC_BOOTSTRAP.md` (added with the GitHub Actions workflows).
