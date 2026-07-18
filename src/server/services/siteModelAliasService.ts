import { asc, eq, inArray, ne } from 'drizzle-orm';
import { isExactTokenRouteModelPattern } from '../../shared/tokenRoutePatterns.js';
import { db, schema } from '../db/index.js';
import { normalizeModelIdentityKey } from './modelIdentity.js';

const MAX_MODEL_NAME_LENGTH = 191;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
type DbClient = typeof db;

export type SiteModelAliasInput = {
  sourceModel: string;
  aliasModel: string;
  enabled?: boolean;
};

export type NormalizedSiteModelAlias = Omit<SiteModelAliasInput, 'enabled'> & {
  enabled: boolean;
  sourceKey: string;
  aliasKey: string;
};

export type SiteModelAliasValidationError = {
  code: 'invalid_alias'
    | 'duplicate_alias'
    | 'self_alias'
    | 'alias_cycle'
    | 'alias_chain'
    | 'canonical_conflict'
    | 'alias_spelling_conflict';
  message: string;
  index: number;
};

export type SiteModelAliasValidationResult =
  | { success: true; aliases: NormalizedSiteModelAlias[] }
  | { success: false; error: SiteModelAliasValidationError };

export type SiteModelAlias = {
  sourceModel: string;
  aliasModel: string;
  enabled: boolean;
};

export type SiteModelAliasRouteNameConflict = {
  code: 'site_alias_name_conflict';
  field: 'modelPattern' | 'displayName';
  aliasModel: string;
  message: string;
};

export class SiteModelAliasInputError extends Error {
  readonly issue: SiteModelAliasValidationError;

  constructor(issue: SiteModelAliasValidationError) {
    super(issue.message);
    this.name = 'SiteModelAliasInputError';
    this.issue = issue;
  }
}

export class SiteModelAliasSiteNotFoundError extends Error {
  readonly siteId: number;

  constructor(siteId: number) {
    super('Site not found');
    this.name = 'SiteModelAliasSiteNotFoundError';
    this.siteId = siteId;
  }
}

async function assertSiteExists(siteId: number, client: DbClient): Promise<void> {
  const site = await client.select({ id: schema.sites.id })
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();
  if (!site) throw new SiteModelAliasSiteNotFoundError(siteId);
}

function isExactAliasName(value: string): boolean {
  return isExactTokenRouteModelPattern(value);
}

/** Finds a site-alias namespace collision for a manual route's exposed names. */
export async function findSiteModelAliasRouteNameConflict(input: {
  modelPattern?: string | null;
  displayName?: string | null;
}, client: DbClient = db): Promise<SiteModelAliasRouteNameConflict | null> {
  const modelPattern = typeof input.modelPattern === 'string' ? input.modelPattern.trim() : '';
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  const candidates: Array<{ field: SiteModelAliasRouteNameConflict['field']; value: string; key: string }> = [];
  if (modelPattern && isExactAliasName(modelPattern)) {
    candidates.push({ field: 'modelPattern', value: modelPattern, key: normalizeModelIdentityKey(modelPattern) });
  }
  if (displayName) {
    candidates.push({ field: 'displayName', value: displayName, key: normalizeModelIdentityKey(displayName) });
  }
  const candidateKeys = Array.from(new Set(candidates.map((candidate) => candidate.key)));
  if (candidateKeys.length === 0) return null;

  const aliases = await client.select({
    aliasModel: schema.siteModelAliases.aliasModel,
    aliasKey: schema.siteModelAliases.aliasKey,
  }).from(schema.siteModelAliases)
    .where(inArray(schema.siteModelAliases.aliasKey, candidateKeys))
    .all();
  for (const candidate of candidates) {
    const alias = aliases.find((row) => row.aliasKey === candidate.key);
    if (!alias) continue;
    return {
      code: 'site_alias_name_conflict',
      field: candidate.field,
      aliasModel: alias.aliasModel,
      message: `Route name conflicts with a site model alias: ${candidate.value}`,
    };
  }
  return null;
}

/** Validates one site's complete alias set using case-insensitive model identity. */
export function validateSiteModelAliases(
  input: unknown,
  options: { reservedModelNames?: Iterable<string> } = {},
): SiteModelAliasValidationResult {
  if (!Array.isArray(input)) {
    return {
      success: false,
      error: { code: 'invalid_alias', message: 'Model aliases must be an array.', index: -1 },
    };
  }

  const aliases: NormalizedSiteModelAlias[] = [];
  const seenAliasKeys = new Set<string>();
  const reservedModelKeys = new Set(
    Array.from(options.reservedModelNames ?? [], normalizeModelIdentityKey).filter(Boolean),
  );

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const sourceModel = typeof item?.sourceModel === 'string' ? item.sourceModel.trim() : '';
    const aliasModel = typeof item?.aliasModel === 'string' ? item.aliasModel.trim() : '';
    const enabled = item?.enabled === undefined ? true : item.enabled;
    const sourceKey = normalizeModelIdentityKey(sourceModel);
    const aliasKey = normalizeModelIdentityKey(aliasModel);

    if (!sourceKey || !aliasKey || typeof enabled !== 'boolean') {
      return {
        success: false,
        error: { code: 'invalid_alias', message: 'Source and alias models are required.', index },
      };
    }
    if (sourceModel.length > MAX_MODEL_NAME_LENGTH || aliasModel.length > MAX_MODEL_NAME_LENGTH) {
      return {
        success: false,
        error: {
          code: 'invalid_alias',
          message: `Model names must be at most ${MAX_MODEL_NAME_LENGTH} characters.`,
          index,
        },
      };
    }
    if (CONTROL_CHARACTER_PATTERN.test(sourceModel) || CONTROL_CHARACTER_PATTERN.test(aliasModel)) {
      return {
        success: false,
        error: {
          code: 'invalid_alias',
          message: 'Model names cannot contain control characters.',
          index,
        },
      };
    }
    if (!isExactAliasName(sourceModel)) {
      return {
        success: false,
        error: {
          code: 'invalid_alias',
          message: `Source model must be an exact model name: ${sourceModel}`,
          index,
        },
      };
    }
    if (!isExactAliasName(aliasModel)) {
      return {
        success: false,
        error: {
          code: 'invalid_alias',
          message: `Alias model must be an exact model name: ${aliasModel}`,
          index,
        },
      };
    }
    if (sourceKey === aliasKey) {
      return {
        success: false,
        error: {
          code: 'self_alias',
          message: `Alias model must differ from source model: ${aliasModel}`,
          index,
        },
      };
    }
    if (reservedModelKeys.has(aliasKey)) {
      return {
        success: false,
        error: {
          code: 'canonical_conflict',
          message: `Alias model conflicts with a canonical model: ${aliasModel}`,
          index,
        },
      };
    }
    if (seenAliasKeys.has(aliasKey)) {
      return {
        success: false,
        error: { code: 'duplicate_alias', message: `Duplicate alias model: ${aliasModel}`, index },
      };
    }

    seenAliasKeys.add(aliasKey);
    aliases.push({ sourceModel, aliasModel, enabled, sourceKey, aliasKey });
  }

  const aliasesByKey = new Map(aliases.map((alias) => [alias.aliasKey, alias]));
  for (let index = 0; index < aliases.length; index += 1) {
    const path: string[] = [];
    let cursor = aliases[index]!.aliasKey;

    while (aliasesByKey.has(cursor)) {
      const cycleStart = path.indexOf(cursor);
      if (cycleStart >= 0) {
        const cycle = [...path.slice(cycleStart), cursor];
        return {
          success: false,
          error: {
            code: 'alias_cycle',
            message: `Model alias cycle detected: ${cycle.join(' -> ')}`,
            index,
          },
        };
      }

      path.push(cursor);
      cursor = aliasesByKey.get(cursor)!.sourceKey;
    }
  }

  for (let index = 0; index < aliases.length; index += 1) {
    const alias = aliases[index]!;
    if (!aliasesByKey.has(alias.sourceKey)) continue;
    return {
      success: false,
      error: {
        code: 'alias_chain',
        message: `Alias sources must be canonical models: ${alias.sourceModel}`,
        index,
      },
    };
  }

  return { success: true, aliases };
}

async function loadKnownCanonicalModelNames(client: DbClient): Promise<string[]> {
  const [accountModels, tokenModels, routes] = await Promise.all([
    client.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(eq(schema.modelAvailability.available, true))
      .all(),
    client.select({ modelName: schema.tokenModelAvailability.modelName })
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.available, true))
      .all(),
    client.select({
      modelPattern: schema.tokenRoutes.modelPattern,
      displayName: schema.tokenRoutes.displayName,
      routeKind: schema.tokenRoutes.routeKind,
    }).from(schema.tokenRoutes).all(),
  ]);
  const routeNames = routes
    .filter((route) => route.routeKind !== 'site_alias')
    .flatMap((route) => [
      isExactAliasName(route.modelPattern) ? route.modelPattern : '',
      route.displayName || '',
    ])
    .filter(Boolean);
  return [
    ...accountModels.map((row) => row.modelName),
    ...tokenModels.map((row) => row.modelName),
    ...routeNames,
  ];
}

async function assertSharedAliasSpellings(
  siteId: number,
  aliases: NormalizedSiteModelAlias[],
  client: DbClient,
): Promise<void> {
  if (aliases.length === 0) return;

  const existingAliases = await client.select({
    aliasModel: schema.siteModelAliases.aliasModel,
    aliasKey: schema.siteModelAliases.aliasKey,
  }).from(schema.siteModelAliases)
    .where(ne(schema.siteModelAliases.siteId, siteId))
    .all();

  for (let index = 0; index < aliases.length; index += 1) {
    const alias = aliases[index]!;
    const conflicting = existingAliases.find((row) => (
      row.aliasKey === alias.aliasKey && row.aliasModel !== alias.aliasModel
    ));
    if (!conflicting) continue;
    throw new SiteModelAliasInputError({
      code: 'alias_spelling_conflict',
      message: `Alias model spelling must match the existing shared alias: ${conflicting.aliasModel}`,
      index,
    });
  }
}

export async function listSiteModelAliases(
  siteId: number,
  client: DbClient = db,
): Promise<SiteModelAlias[]> {
  const rows = await client.select({
    sourceModel: schema.siteModelAliases.sourceModel,
    aliasModel: schema.siteModelAliases.aliasModel,
    enabled: schema.siteModelAliases.enabled,
  }).from(schema.siteModelAliases)
    .where(eq(schema.siteModelAliases.siteId, siteId))
    .orderBy(asc(schema.siteModelAliases.aliasKey))
    .all();

  return rows.map((row) => ({
    sourceModel: row.sourceModel,
    aliasModel: row.aliasModel,
    enabled: row.enabled,
  }));
}

/** Lists aliases only after verifying that the owning site still exists. */
export async function getSiteModelAliases(
  siteId: number,
  client: DbClient = db,
): Promise<SiteModelAlias[]> {
  await assertSiteExists(siteId, client);
  return listSiteModelAliases(siteId, client);
}

async function replaceSiteModelAliasesWithClient(
  siteId: number,
  input: unknown,
  client: DbClient,
): Promise<SiteModelAlias[]> {
  await assertSiteExists(siteId, client);
  const validation = validateSiteModelAliases(input, {
    reservedModelNames: await loadKnownCanonicalModelNames(client),
  });
  if (!validation.success) {
    throw new SiteModelAliasInputError(validation.error);
  }
  await assertSharedAliasSpellings(siteId, validation.aliases, client);

  await client.delete(schema.siteModelAliases)
    .where(eq(schema.siteModelAliases.siteId, siteId))
    .run();
  if (validation.aliases.length > 0) {
    await client.insert(schema.siteModelAliases).values(
      validation.aliases.map((alias) => ({
        siteId,
        sourceModel: alias.sourceModel,
        aliasModel: alias.aliasModel,
        aliasKey: alias.aliasKey,
        enabled: alias.enabled,
      })),
    ).run();
  }

  return listSiteModelAliases(siteId, client);
}

/** Replaces one site's complete alias set atomically after cross-row validation. */
export async function replaceSiteModelAliases(
  siteId: number,
  input: unknown,
  client?: DbClient,
): Promise<SiteModelAlias[]> {
  if (client) {
    return replaceSiteModelAliasesWithClient(siteId, input, client);
  }
  return db.transaction((tx: DbClient) => replaceSiteModelAliasesWithClient(siteId, input, tx));
}
