import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../index.js';

const baseEnv = {
  API_KEY: 'test-api-key',
} as Env['Bindings'];

async function request(path: string, env: Env['Bindings']): Promise<Response> {
  return worker.fetch(
    new Request(`https://ig-harness.example.com${path}`),
    env,
    {} as ExecutionContext,
  );
}

describe('GET /line configuration', () => {
  it('fails closed when LINE_LIFF_ID is missing', async () => {
    const res = await request('/line', {
      ...baseEnv,
      LINE_ADD_URL: 'https://line-harness.example.com/auth/line',
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('LINE_LIFF_ID');
  });

  it('fails closed in test mode when LINE_ADD_URL is missing', async () => {
    const res = await request('/line?test=1', {
      ...baseEnv,
      LINE_LIFF_ID: '1234567890-AbCdEfGh',
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('LINE_ADD_URL');
  });

  it('renders only self-host configuration values when both are set', async () => {
    const res = await request('/line?test=1&ref=campaign', {
      ...baseEnv,
      LINE_LIFF_ID: '1234567890-AbCdEfGh',
      LINE_ADD_URL: 'https://line-harness.example.com/auth/line',
    });
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('https://liff.line.me/1234567890-AbCdEfGh');
    expect(html).toContain('https://line-harness.example.com/auth/line');
  });

  it('does not require the test-only LINE_ADD_URL on the production page', async () => {
    const res = await request('/line?ref=campaign', {
      ...baseEnv,
      LINE_LIFF_ID: '1234567890-AbCdEfGh',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('https://liff.line.me/1234567890-AbCdEfGh');
  });
});
