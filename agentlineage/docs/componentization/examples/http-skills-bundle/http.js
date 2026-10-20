import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'component-demo';
export const inject = ['tools'];

// Teaching contract: GET <baseUrl>/health returns a small JSON object
// with a string status. Configuration belongs to the profile, not tool input.
export function apply(ctx, config = {}) {
  if (typeof config.baseUrl !== 'string') {
    throw new Error('component-demo: baseUrl is required');
  }
  const base = new URL(config.baseUrl.endsWith('/')
    ? config.baseUrl : config.baseUrl + '/');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash
      || !(base.protocol === 'https:' || (base.protocol === 'http:' && local))) {
    throw new Error('component-demo: use HTTPS or loopback HTTP without credentials/query/hash');
  }
  const headers = { Accept: 'application/json' };
  if (config.tokenEnv !== undefined) {
    if (typeof config.tokenEnv !== 'string' || !config.tokenEnv
        || !process.env[config.tokenEnv]) {
      throw new Error('component-demo: configured token environment variable is missing');
    }
    headers.Authorization = `Bearer ${process.env[config.tokenEnv]}`;
  }
  const endpoint = new URL('health', base);
  const tool = defineTool({
    name: 'component_health',
    description: 'Read the configured example service health status. Does not start the service.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, exec) {
      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.any([exec.signal, AbortSignal.timeout(5000)]),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`component-demo: HTTP ${response.status}`);
      const body = await response.json();
      if (!body || typeof body.status !== 'string' || body.status.length > 256) {
        throw new Error('component-demo: invalid health response');
      }
      return { status: body.status };
    },
  });
  ctx.effect(() => ctx.tools.register(tool));
}
