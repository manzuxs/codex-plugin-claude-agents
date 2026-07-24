const BROWSER_CONFIG_AGENTS = new Set(['ui-designer', 'frontend-engineer', 'qa-engineer']);

export function visibleConfigFields(capabilities = {}, agentId = '') {
  const fields = new Set(Array.isArray(capabilities.configFields) ? capabilities.configFields : []);
  if (!BROWSER_CONFIG_AGENTS.has(agentId)) fields.delete('browserMcpConfigsJson');
  return fields;
}

export function capabilityOptions(capabilities = {}, field) {
  const configured = capabilities.configOptions?.[field];
  return Array.isArray(configured) ? configured : Array.isArray(capabilities[field]) ? capabilities[field] : [];
}

export function effortOptionsForModel(capabilities = {}, model) {
  const runnerEfforts = capabilityOptions(capabilities, 'effort');
  const modelEfforts = Array.isArray(model?.supportedEfforts) ? model.supportedEfforts : [];
  if (!modelEfforts.length) return runnerEfforts;
  const modelSet = new Set(modelEfforts);
  return runnerEfforts.filter((effort) => effort === 'default' || modelSet.has(effort));
}
