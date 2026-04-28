variable "domain_name" {
  description = "Public domain name the portal will serve at (e.g., 'ironforge.rickycaballero.com'). Must be covered by the certificate referenced in certificate_arn and resolvable inside the hosted zone referenced in hosted_zone_id."
  type        = string
}

variable "certificate_arn" {
  description = "ARN of a us-east-1 ACM certificate covering domain_name. CloudFront only accepts us-east-1 certs."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID where the portal A/AAAA alias records will be created. Must be the zone for the parent of (or equal to) domain_name."
  type        = string
}
