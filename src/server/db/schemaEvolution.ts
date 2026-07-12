/** Destructive schema changes explicitly approved by versioned feature designs. */
export const INTENTIONAL_SCHEMA_COLUMN_REMOVALS = [
  'accounts.unit_cost',
  'accounts.oauth_provider',
  'accounts.oauth_account_key',
  'accounts.oauth_project_id',
  'route_channels.oauth_route_unit_id',
] as const;

export const INTENTIONAL_SCHEMA_TABLE_REMOVALS = [
  'oauth_route_unit_members',
  'oauth_route_units',
] as const;
