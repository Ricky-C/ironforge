{
  "Comment": "Ironforge deprovisioning workflow (Phase 1.5 DELETE /api/services/:id). Two-state happy path — DeprovisionTerraform reuses run-terraform with action=destroy, then DeleteExternalResources cleans up the GitHub repo + tfstate file and archives the Service. Catch on each routes to DeprovisionFailed for the terminal-failure DDB transitions; that Lambda does NOT re-run the destroy chain (would mask original failure / hit inconsistent partial state — see handler source).",
  "StartAt": "InitDeprovisionSteps",
  "States": {
    "InitDeprovisionSteps": {
      "Type": "Pass",
      "Comment": "Seeds $.steps as an empty object so DeprovisionTerraform's ResultPath ($.steps.deprovision-terraform) resolves on the first state and DeprovisionFailed's Parameters block can reference $.steps without a States.PathFailed when State 1's Catch fires before any state has populated it. Same convention as the provisioning SFN's InitCloudFrontPolling — runtime-fail-prevention via explicit init.",
      "Result": {},
      "ResultPath": "$.steps",
      "Next": "DeprovisionTerraform"
    },
    "DeprovisionTerraform": {
      "Type": "Task",
      "Resource": "${run_terraform_arn}",
      "Comment": "Reuses the run-terraform Lambda with action=destroy via Parameters injection. The Lambda accepts {WorkflowExecutionInput, action: \"apply\"|\"destroy\"} per its existing handle-event contract; no Lambda changes needed. Note: run-terraform's internal JobStep writes are conditional on action===\"apply\" (see handle-event.ts:430), so this state does NOT produce a JobStep#deprovision-terraform entry — observability comes from SFN execution history only. Tracked in docs/tech-debt.md § \"JobStep#deprovision-terraform observability gap\".",
      "Parameters": {
        "serviceId.$": "$.serviceId",
        "jobId.$": "$.jobId",
        "executionName.$": "$.executionName",
        "serviceName.$": "$.serviceName",
        "ownerId.$": "$.ownerId",
        "templateId.$": "$.templateId",
        "inputs.$": "$.inputs",
        "action": "destroy"
      },
      "Retry": [],
      "Catch": [
        {
          "ErrorEquals": ["States.ALL"],
          "ResultPath": "$.error",
          "Next": "DeprovisionFailed"
        }
      ],
      "ResultPath": "$.steps.deprovision-terraform",
      "Next": "DeleteExternalResources"
    },
    "DeleteExternalResources": {
      "Type": "Task",
      "Resource": "${delete_external_resources_arn}",
      "Comment": "State 2 happy path. Deletes GitHub repo + tfstate file via @ironforge/destroy-chain primitives, then transitions Service deprovisioning -> archived and Job running -> succeeded. Throws on any sub-op failure so the Catch routes to DeprovisionFailed.",
      "Parameters": {
        "jobId.$": "$.jobId",
        "serviceId.$": "$.serviceId",
        "serviceName.$": "$.serviceName"
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
          "Next": "DeprovisionFailed"
        }
      ],
      "ResultPath": "$.steps.deprovision-external-resources",
      "End": true
    },
    "DeprovisionFailed": {
      "Type": "Task",
      "Resource": "${deprovision_failed_arn}",
      "Comment": "Terminal-failure DDB transitions. Service deprovisioning -> failed (failedWorkflow=\"deprovisioning\") and Job running -> failed. Idempotent on re-fire. Does NOT re-run the destroy chain — that would mask the original failure or hit inconsistent partial-destroy state. Recovery is operator-driven via re-issuing DELETE.",
      "Parameters": {
        "jobId.$": "$.jobId",
        "serviceId.$": "$.serviceId",
        "steps.$": "$.steps",
        "error.$": "$.error"
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
      "Cause": "Deprovisioning workflow ended via DeprovisionFailed path. See JobStep entries and the $.error ResultPath for the originating failure."
    }
  }
}
