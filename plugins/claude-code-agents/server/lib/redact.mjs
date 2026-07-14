const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|credential|authorization)/i;

export function redactObject(value) {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactObject(child)]));
}

export function collectSensitiveValues(env) {
  return Object.entries(env || {})
    .filter(([key, value]) => SENSITIVE_KEY.test(key) && value !== undefined && value !== null && String(value).length >= 4)
    .map(([, value]) => String(value));
}

export function redactText(text, secrets = []) {
  let result = String(text ?? '');
  const unique = [...new Set(secrets.filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
  for (const secret of unique) result = result.split(secret).join('[REDACTED]');
  return result;
}
