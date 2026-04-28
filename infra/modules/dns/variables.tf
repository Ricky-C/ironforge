variable "domain_name" {
  description = "Apex of the subdomain hosted zone (e.g., 'ironforge.rickycaballero.com'). The certificate covers this name and a wildcard '*.<domain_name>'. The hosted zone for this name must already exist in Route53 — this module references it via data source, never creates one."
  type        = string

  validation {
    condition     = !startswith(var.domain_name, "*.")
    error_message = "domain_name must be the apex (e.g., 'ironforge.rickycaballero.com'), not a wildcard."
  }
}
