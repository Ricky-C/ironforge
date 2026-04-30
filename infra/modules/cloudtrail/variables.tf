# This module takes no inputs.
# Trail name, retention, and the Object Lock window are intentionally fixed
# so the encryption-context strings in the KMS key policy can reference them
# as constants. Tuning any of those values is a deliberate code change here,
# not a parent-composition variable.
