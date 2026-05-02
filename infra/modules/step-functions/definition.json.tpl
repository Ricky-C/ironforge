{
  "Comment": "Ironforge provisioning workflow. See docs/state-machine.md for the retry-and-catch rationale, error-class taxonomy, and ResultPath threading.",
  "StartAt": "ValidateInputs",
  "States": {
    "ValidateInputs": {
      "Type": "Task",
      "Resource": "${validate_inputs_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 2,
          "MaxAttempts": 2,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.validate-inputs",
      "Next": "CreateRepo"
    },
    "CreateRepo": {
      "Type": "Task",
      "Resource": "${create_repo_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 2,
          "MaxAttempts": 2,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.create-repo",
      "Next": "GenerateCode"
    },
    "GenerateCode": {
      "Type": "Task",
      "Resource": "${generate_code_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 2,
          "MaxAttempts": 1,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.generate-code",
      "Next": "RunTerraform"
    },
    "RunTerraform": {
      "Type": "Task",
      "Resource": "${run_terraform_arn}",
      "Retry": [],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.run-terraform",
      "Next": "WaitForCloudFront"
    },
    "WaitForCloudFront": {
      "Type": "Task",
      "Resource": "${wait_for_cloudfront_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 5,
          "MaxAttempts": 1,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.wait-for-cloudfront",
      "Next": "TriggerDeploy"
    },
    "TriggerDeploy": {
      "Type": "Task",
      "Resource": "${trigger_deploy_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 2,
          "MaxAttempts": 2,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.trigger-deploy",
      "Next": "Finalize"
    },
    "Finalize": {
      "Type": "Task",
      "Resource": "${finalize_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 2,
          "MaxAttempts": 1,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "CleanupOnFailure"
        }
      ],
      "ResultPath": "$.steps.finalize",
      "End": true
    },
    "CleanupOnFailure": {
      "Type": "Task",
      "Resource": "${cleanup_on_failure_arn}",
      "Retry": [
        {
          "ErrorEquals": [
            "Lambda.ServiceException",
            "Lambda.AWSLambdaException",
            "Lambda.SdkClientException",
            "Lambda.TooManyRequestsException",
            "States.Timeout"
          ],
          "IntervalSeconds": 1,
          "MaxAttempts": 3,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "Next": "TerminalFail"
        }
      ],
      "Next": "TerminalFail"
    },
    "TerminalFail": {
      "Type": "Fail",
      "Cause": "Workflow ended via cleanup-on-failure path. See JobStep entries and the $.error ResultPath for the originating failure."
    }
  }
}
