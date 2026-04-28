variable "route53_zone_arn" {
  description = "ARN of the Ironforge subdomain Route53 hosted zone. Used in the boundary's AllowRoute53OnIronforgeZone statement to scope Route53 actions to this zone only — never the parent zone or all zones."
  type        = string
}
