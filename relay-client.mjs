import { callerSetting } from './settings.mjs';

export async function requestRelay(path, body) {
  const token = callerSetting(process.env, 'CALLER_CLOUD_TOKEN')?.trim();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('http://127.0.0.1:47831' + path, {
    headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
}
