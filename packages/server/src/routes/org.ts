// Org read view + membership actions, proxied through the local server.
//
// Same arrangement as the runner routes (see runners.ts): the renderer never
// holds the account's device token, so it calls these thin pass-throughs and
// the server injects the token from ~/.strado/license.json.
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createCloudApi } from '../services/cloudApi.js';

const OrgIdBody = z.object({ orgId: z.string().min(1).max(64) });
const NameBody = z.object({ name: z.string().min(1).max(120) });
const EmailBody = z.object({ email: z.string().email().max(254) });
const InvitationParams = z.object({ id: z.string().min(1).max(64) });

export async function registerOrgRoutes(app: FastifyInstance): Promise<void> {
  const { token, cloud } = createCloudApi();

  app.get('/api/org', async () => {
    const t = await token();
    return cloud(`/v1/org?token=${encodeURIComponent(t)}`);
  });

  app.post('/api/org/switch', async (req) => {
    const { orgId } = OrgIdBody.parse(req.body);
    const t = await token();
    return cloud('/v1/org/switch', { method: 'POST', body: { token: t, orgId } });
  });

  app.post('/api/org/rename', async (req) => {
    const { name } = NameBody.parse(req.body);
    const t = await token();
    return cloud('/v1/org/rename', { method: 'POST', body: { token: t, name } });
  });

  app.post('/api/org/invitations', async (req) => {
    const { email } = EmailBody.parse(req.body);
    const t = await token();
    return cloud('/v1/org/invitations', { method: 'POST', body: { token: t, email } });
  });

  app.post('/api/org/invitations/cancel', async (req) => {
    const { email } = EmailBody.parse(req.body);
    const t = await token();
    return cloud('/v1/org/invitations/cancel', { method: 'POST', body: { token: t, email } });
  });

  app.post('/api/org/invitations/:id/accept', async (req) => {
    const { id } = InvitationParams.parse(req.params);
    const t = await token();
    return cloud('/v1/org/invitations/accept', { method: 'POST', body: { token: t, invitationId: id } });
  });

  app.post('/api/org/invitations/:id/decline', async (req) => {
    const { id } = InvitationParams.parse(req.params);
    const t = await token();
    return cloud('/v1/org/invitations/decline', { method: 'POST', body: { token: t, invitationId: id } });
  });

  app.post('/api/org/members/remove', async (req) => {
    const { email } = EmailBody.parse(req.body);
    const t = await token();
    return cloud('/v1/org/members/remove', { method: 'POST', body: { token: t, email } });
  });

  app.post('/api/org/leave', async () => {
    const t = await token();
    return cloud('/v1/org/leave', { method: 'POST', body: { token: t } });
  });
}
