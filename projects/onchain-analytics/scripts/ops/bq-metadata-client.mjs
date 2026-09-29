// Read-only BigQuery metadata client.
//
// This module can issue HTTP GET requests to the BigQuery metadata endpoints and nothing else.
// It has no query, job, insert, patch or delete path, and it contains no SQL. That is deliberate:
// the state manifest that operations tooling depends on must be impossible to turn into a writer,
// whatever a caller passes it.
//
// Authentication uses Application Default Credentials through the gcloud CLI. No key file is read
// and no token is written to disk or to stdout.

import { execFileSync } from 'node:child_process';

const GET_ONLY_ENDPOINTS = [
  /^https:\/\/bigquery\.googleapis\.com\/bigquery\/v2\/projects\/[\w.-]+\/datasets(\?.*)?$/,
  /^https:\/\/bigquery\.googleapis\.com\/bigquery\/v2\/projects\/[\w.-]+\/datasets\/[\w$-]+$/,
  /^https:\/\/bigquery\.googleapis\.com\/bigquery\/v2\/projects\/[\w.-]+\/datasets\/[\w$-]+\/tables(\?.*)?$/,
  /^https:\/\/bigquery\.googleapis\.com\/bigquery\/v2\/projects\/[\w.-]+\/datasets\/[\w$-]+\/tables\/[\w$-]+(\?.*)?$/,
];

let cachedToken = null;

function accessToken() {
  if (cachedToken) return cachedToken;
  cachedToken = execFileSync(
    process.env.COMSPEC || 'cmd.exe',
    ['/c', 'gcloud', 'auth', 'application-default', 'print-access-token'],
    { encoding: 'utf8', timeout: 180_000 }
  ).trim();
  if (!cachedToken || cachedToken.length < 40) {
    throw new Error('No access token was returned by gcloud. Run: gcloud auth application-default login');
  }
  return cachedToken;
}

/**
 * Issues one GET against an allowlisted BigQuery metadata endpoint.
 * Returns { ok, status, json, errorMessage }. An HTTP error never throws, so a caller can count
 * errors separately from results instead of mistaking a failure for an empty answer.
 */
export async function get(url, { timeoutMs = 120_000 } = {}) {
  if (!GET_ONLY_ENDPOINTS.some((pattern) => pattern.test(url))) {
    throw new Error(`Refused: ${url} is not a BigQuery metadata endpoint on the read-only allowlist.`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken()}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
    return {
      ok: res.ok,
      status: res.status,
      json,
      errorMessage: res.ok ? null : (json?.error?.message ?? text.slice(0, 400)),
    };
  } catch (e) {
    return { ok: false, status: 0, json: null, errorMessage: `${e.name}: ${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

export function listDatasetsUrl(project) {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets?all=true&maxResults=1000`;
}

export function datasetUrl(project, dataset) {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}`;
}

export function listTablesUrl(project, dataset, pageToken) {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}/tables?maxResults=1000`;
  return pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
}

export function tableUrl(project, dataset, table) {
  return `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${dataset}/tables/${table}`;
}
