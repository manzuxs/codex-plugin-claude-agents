export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildDelegationPrompt({ agent, task, plan, acceptanceCriteria = '', context = '', browserMode = 'none', browserMcpProfile = '', browserPurpose = '', browserCompletionGate = '', codexReviewRequired = true }) {
  if (!String(task || '').trim()) throw new Error('task is required');
  if (!String(plan || '').trim()) throw new Error('plan is required; Codex must plan before delegation');
  return `<?xml version="1.0" encoding="UTF-8"?>
<delegation version="1.0">
  <source>Codex</source>
  <selected_agent id="${escapeXml(agent.id)}">${escapeXml(agent.name)}</selected_agent>
  <objective>${escapeXml(task)}</objective>
  <codex_plan>${escapeXml(plan)}</codex_plan>
  <acceptance_criteria>${escapeXml(acceptanceCriteria)}</acceptance_criteria>
  <additional_context>${escapeXml(context)}</additional_context>
  <browser_testing required="${browserMode !== 'none'}" mode="${escapeXml(browserMode)}" purpose="${escapeXml(browserPurpose)}" mcp_profile="${escapeXml(browserMcpProfile)}">
    <completion_gate>${escapeXml(browserCompletionGate || 'When required, do not report completed unless a real browser was launched, the specified user paths were exercised, and reproducible evidence was recorded.')}</completion_gate>
  </browser_testing>
  <execution_contract>
    <instruction>Use the current working repository as the source of truth.</instruction>
    <instruction>Follow the Codex plan in order, adapting only when repository evidence requires it.</instruction>
    <instruction>Make real edits and run relevant checks when the selected permission mode permits.</instruction>
    <instruction>Do not broaden scope, overwrite user work, or conceal failed verification.</instruction>
    <instruction>Return a concise implementation report for Codex review.</instruction>
    <codex_review_required>${codexReviewRequired ? 'true' : 'false'}</codex_review_required>
  </execution_contract>
</delegation>`;
}
