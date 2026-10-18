/**
 * Surface segmentation and SAM live in the Python model service. These routes only check the cheap
 * things (is Google set up, is the service usable) and then hand the request to the streaming proxy.
 */
import { sendError } from '../lib/errors.js';

export function mountModelRoutes(app, ctx) {
  const { api, model } = ctx;
  // The service also accepts SAM_SERVER_KEY on /sam/*, which matters when it runs on its own without MODEL_SERVICE_KEY.
  // The browser has been checked against that key by now; what travels on is our own copy, never the browser's header.
  const samHeaders = () => {
    const key = ctx.settings().sam.serverKey;
    return key ? { 'x-api-key': key } : {};
  };

  api.post('/api/segment', async (req, res) => {
    const google = ctx.settings().google;
    if (!google.configured) {
      return sendError(res, 503, google.error || 'Google Cloud is not configured on this server. Add credentials to .env.', 'FAILED_PRECONDITION');
    }
    await model.forward(req, res, '/segment');
  });

  api.get('/api/sam/health', async (req, res) => {
    const status = await model.status();
    if (status.status !== 'ready') {
      return res.json({ status: 'unavailable', model: '', backend: '', device: '', interactive: false, text_prompts: false, error: model.unavailableMessage(status) });
    }
    await model.forward(req, res, '/sam/health', samHeaders());
  });

  api.post('/api/sam/refine', (req, res) => model.forward(req, res, '/sam/refine', samHeaders()));
  api.post('/api/sam/segment', (req, res) => model.forward(req, res, '/sam/segment', samHeaders()));
}
