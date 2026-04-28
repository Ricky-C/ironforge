variable "clients" {
  description = "Map of env name to client config. Each entry creates a Cognito user pool client scoped to that env's callback/logout URLs. Map keys (env names) appear in client names and outputs."
  type = map(object({
    callback_urls = list(string)
    logout_urls   = list(string)
  }))

  validation {
    condition     = length(var.clients) > 0
    error_message = "At least one client must be configured."
  }
}
