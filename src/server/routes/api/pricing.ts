import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  parseAccountGroupRateRulePayload,
  parsePricingSettingsPayload,
  parseSiteModelPriceRulePayload,
  parseSitePricingProfilePayload,
} from '../../contracts/pricingRoutePayloads.js';
import {
  getPricingSettings,
  getSitePricing,
  refreshPricing,
  removeAccountGroupRateRule,
  removeSiteModelPriceRule,
  saveAccountGroupRateRule,
  saveSiteModelPriceRule,
  saveSitePricingProfile,
  updatePricingSettings,
} from '../../pricing/pricingAdminService.js';

function parseId(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ success: false, error });
}

export async function pricingRoutes(app: FastifyInstance) {
  app.get('/api/pricing/settings', getPricingSettings);

  app.put<{ Body: unknown }>('/api/pricing/settings', async (request, reply) => {
    const parsed = parsePricingSettingsPayload(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error);
    return updatePricingSettings(parsed.data);
  });

  app.post('/api/pricing/refresh', refreshPricing);

  app.get<{ Params: { siteId: string } }>('/api/sites/:siteId/pricing', async (request, reply) => {
    const siteId = parseId(request.params.siteId);
    if (!siteId) return badRequest(reply, 'Invalid siteId');
    const result = await getSitePricing(siteId);
    return result ?? reply.code(404).send({ error: 'Site not found' });
  });

  app.put<{ Params: { siteId: string }; Body: unknown }>(
    '/api/sites/:siteId/pricing/profile',
    async (request, reply) => {
      const siteId = parseId(request.params.siteId);
      if (!siteId) return badRequest(reply, 'Invalid siteId');
      const parsed = parseSitePricingProfilePayload(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!await saveSitePricingProfile(siteId, parsed.data)) {
        return reply.code(404).send({ error: 'Site not found' });
      }
      return { success: true, profile: parsed.data };
    },
  );

  app.put<{ Params: { siteId: string; upstreamModelId: string }; Body: unknown }>(
    '/api/sites/:siteId/pricing/models/:upstreamModelId/rule',
    async (request, reply) => {
      const siteId = parseId(request.params.siteId);
      if (!siteId) return badRequest(reply, 'Invalid siteId');
      const parsed = parseSiteModelPriceRulePayload(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!await saveSiteModelPriceRule(siteId, request.params.upstreamModelId, parsed.data)) {
        return reply.code(404).send({ error: 'Site not found' });
      }
      return { success: true };
    },
  );

  app.delete<{ Params: { siteId: string; upstreamModelId: string } }>(
    '/api/sites/:siteId/pricing/models/:upstreamModelId/rule',
    async (request, reply) => {
      const siteId = parseId(request.params.siteId);
      if (!siteId) return badRequest(reply, 'Invalid siteId');
      const deleted = await removeSiteModelPriceRule(siteId, request.params.upstreamModelId);
      if (deleted === null) return reply.code(404).send({ error: 'Site not found' });
      return { success: true, deleted };
    },
  );

  app.put<{ Params: { accountId: string; groupKey: string }; Body: unknown }>(
    '/api/accounts/:accountId/group-rates/:groupKey/rule',
    async (request, reply) => {
      const accountId = parseId(request.params.accountId);
      if (!accountId) return badRequest(reply, 'Invalid accountId');
      const parsed = parseAccountGroupRateRulePayload(request.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      if (!await saveAccountGroupRateRule(accountId, request.params.groupKey, parsed.data.ratioOverride)) {
        return reply.code(404).send({ error: 'Account not found' });
      }
      return { success: true };
    },
  );

  app.delete<{ Params: { accountId: string; groupKey: string } }>(
    '/api/accounts/:accountId/group-rates/:groupKey/rule',
    async (request, reply) => {
      const accountId = parseId(request.params.accountId);
      if (!accountId) return badRequest(reply, 'Invalid accountId');
      const deleted = await removeAccountGroupRateRule(accountId, request.params.groupKey);
      if (deleted === null) return reply.code(404).send({ error: 'Account not found' });
      return { success: true, deleted };
    },
  );
}
