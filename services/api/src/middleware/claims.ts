import { z } from "zod";

// Verified subset of Cognito access-token claims attached to Hono context.
// Access tokens with the pool's current scope config (`openid email profile`,
// code flow with PKCE) carry: sub, iss, client_id, token_use, scope,
// auth_time, exp, iat, jti, username, origin_jti, version. Of these:
//   - iss, client_id, token_use, exp are verified by the middleware itself
//     (handlers don't need to re-check them).
//   - sub is the canonical user identifier for authorization.
// Email and other profile attributes live on ID tokens or via userInfo /
// DynamoDB lookup, not access tokens. Add fields here only when a handler
// genuinely needs them.
export const IronforgeUserSchema = z.object({
  sub: z.string().min(1),
});

export type IronforgeUser = z.infer<typeof IronforgeUserSchema>;
