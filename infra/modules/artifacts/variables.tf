# This module takes no inputs.
# Bucket name derives from data.aws_caller_identity.current.account_id;
# all other settings are intentionally fixed. Per-env tuning happens via
# the prefix-scoped lifecycle rules in main.tf.
