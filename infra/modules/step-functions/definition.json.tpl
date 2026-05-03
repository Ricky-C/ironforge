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
      "Next": "InitCloudFrontPolling"
    },
    "InitCloudFrontPolling": {
      "Type": "Pass",
      "Comment": "Polling-loop init. Seeds $.steps.wait-for-cloudfront with the discriminator the Lambda's HandlerInputSchema accepts on a first tick. Without this, WaitForCloudFront's Parameters block would runtime-fail on the first invocation because $.steps.wait-for-cloudfront wouldn't exist yet — SFN doesn't support default values for missing JSON paths. Convention: every polling loop begins with an Init Pass state injecting Result: { status: \"init\" } at the loop's state path.",
      "Result": { "status": "init" },
      "ResultPath": "$.steps.wait-for-cloudfront",
      "Next": "WaitForCloudFront"
    },
    "WaitForCloudFront": {
      "Type": "Task",
      "Resource": "${wait_for_cloudfront_arn}",
      "Comment": "Single-shot poll tick. Calls cloudfront:GetDistribution and returns PollResult. SFN-level Retry catches Lambda-platform transients (one retry); the polling cap is the wall-clock 20-minute budget enforced inside the Lambda — see docs/state-machine.md § \"WaitForCloudFront retry table row\".",
      "Parameters": {
        "jobId.$": "$.jobId",
        "distributionId.$": "$.steps.run-terraform.distribution_id",
        "previousPoll.$": "$.steps.wait-for-cloudfront"
      },
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
      "Next": "WaitForCloudFrontChoice"
    },
    "WaitForCloudFrontChoice": {
      "Type": "Choice",
      "Comment": "Routes the latest PollResult. status === \"succeeded\" exits the loop. Default routes to the Wait tick. There is no failed branch — IronforgePollTimeoutError is thrown by the Lambda on budget exhaustion, which is caught by WaitForCloudFront's Catch on States.ALL above.",
      "Choices": [
        {
          "Variable": "$.steps.wait-for-cloudfront.status",
          "StringEquals": "succeeded",
          "Next": "TriggerDeploy"
        }
      ],
      "Default": "WaitForCloudFrontWaitTick"
    },
    "WaitForCloudFrontWaitTick": {
      "Type": "Wait",
      "Comment": "Inter-tick wait. SecondsPath consumes the Lambda's PollResult.in_progress.nextWaitSeconds (schedule lives in handle-event.ts, not here). Wait states are free; this is the SFN-orchestrated polling primitive that replaces in-Lambda sleep loops.",
      "SecondsPath": "$.steps.wait-for-cloudfront.nextWaitSeconds",
      "Next": "WaitForCloudFront"
    },
    "TriggerDeploy": {
      "Type": "Task",
      "Resource": "${trigger_deploy_arn}",
      "Comment": "Sets 3 GitHub Actions repo secrets (deploy role ARN, bucket name, distribution ID) on the user's repo, then fires workflow_dispatch on deploy.yml with the jobId as correlation_id. Order is fixed inside the Lambda: secrets BEFORE dispatch, else the run starts with stale/empty secrets.",
      "Parameters": {
        "jobId.$": "$.jobId",
        "serviceId.$": "$.serviceId",
        "repoFullName.$": "$.steps.create-repo.repoFullName",
        "defaultBranch.$": "$.steps.create-repo.defaultBranch",
        "deployRoleArn.$": "$.steps.run-terraform.deploy_role_arn",
        "bucketName.$": "$.steps.run-terraform.bucket_name",
        "distributionId.$": "$.steps.run-terraform.distribution_id"
      },
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
      "Next": "InitDeployPolling"
    },
    "InitDeployPolling": {
      "Type": "Pass",
      "Comment": "Polling-loop init for wait-for-deploy. Same convention as InitCloudFrontPolling — seeds $.steps.wait-for-deploy with { status: \"init\" } so WaitForDeploy's Parameters block can reference $.steps.wait-for-deploy without runtime-failing on the first tick.",
      "Result": { "status": "init" },
      "ResultPath": "$.steps.wait-for-deploy",
      "Next": "WaitForDeploy"
    },
    "WaitForDeploy": {
      "Type": "Task",
      "Resource": "${wait_for_deploy_arn}",
      "Comment": "Single-shot poll tick. Calls listWorkflowRuns filtered by run-name match (Deploy [<correlationId>]) and returns PollResult. SFN-level Retry catches Lambda-platform transients; the polling cap is the wall-clock 10-minute budget enforced inside the Lambda. Status-integrity Lambda — succeeds only after the deploy.yml run completes successfully, so Finalize's transition to Service.status='live' reflects the actual functional state.",
      "Parameters": {
        "jobId.$": "$.jobId",
        "correlationId.$": "$.steps.trigger-deploy.correlationId",
        "repoFullName.$": "$.steps.trigger-deploy.repoFullName",
        "previousPoll.$": "$.steps.wait-for-deploy"
      },
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
      "ResultPath": "$.steps.wait-for-deploy",
      "Next": "WaitForDeployChoice"
    },
    "WaitForDeployChoice": {
      "Type": "Choice",
      "Comment": "Routes the latest PollResult. status === \"succeeded\" exits the loop into Finalize. Default routes to the Wait tick. No failed branch — IronforgePollTimeoutError + IronforgeDeployRunError are thrown by the Lambda and caught by WaitForDeploy's Catch on States.ALL.",
      "Choices": [
        {
          "Variable": "$.steps.wait-for-deploy.status",
          "StringEquals": "succeeded",
          "Next": "Finalize"
        }
      ],
      "Default": "WaitForDeployWaitTick"
    },
    "WaitForDeployWaitTick": {
      "Type": "Wait",
      "Comment": "Inter-tick wait. SecondsPath consumes the Lambda's PollResult.in_progress.nextWaitSeconds (schedule lives in handle-event.ts).",
      "SecondsPath": "$.steps.wait-for-deploy.nextWaitSeconds",
      "Next": "WaitForDeploy"
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
