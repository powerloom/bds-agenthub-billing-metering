/**
 * `api_keys.session_id` references `signup_sessions`. Pay-signup API keys use this
 * placeholder session row (see `db/migrate.ts`); the browser rail is unchanged.
 */
export const PAY_RAIL_PLACEHOLDER_SESSION_ID = "b0000000-0000-4000-8000-00000000pay1" as const;
