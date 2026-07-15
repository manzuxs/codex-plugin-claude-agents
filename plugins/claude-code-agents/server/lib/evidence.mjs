const TRUNCATION_MARKER = '\n[输出已截断]';
const SECTION_SPECS = [
  { key: 'outcome', maxBytes: 320, aliases: ['outcome', 'result', '结果', '结论', '执行结果'] },
  { key: 'verificationSummary', maxBytes: 1800, aliases: ['verification evidence', 'verification actually performed', 'verification', 'validation', 'tests', '验证证据', '验证结果', '验证', '测试结果'] },
  { key: 'unfinishedItemsAndRisks', maxBytes: 1400, aliases: ['unfinished items and risks', 'unfinished items', 'known limitations residual risks migrations and follow up decisions', 'known limitations', 'residual risks', '未完成与风险', '未完成项和风险', '未完成项', '已知限制', '残余风险'] },
  { key: 'filesChanged', maxBytes: 1200, aliases: ['files changed and the reason for each change', 'files changed', 'changed files', 'file list', '变更文件', '文件清单', '修改文件'] },
  { key: 'summary', maxBytes: 1400, aliases: ['implementation summary', 'summary', '实施摘要', '实现摘要', '完成内容'] },
  { key: 'recommendedNextStage', maxBytes: 700, aliases: ['recommended next stage', 'next stage', 'next steps', '下一阶段', '建议下一阶段', '后续步骤'] },
];

function textBytes(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function truncateUtf8(value, maxBytes) {
  const original = String(value || '');
  if (textBytes(original) <= maxBytes) return original;
  let low = 0;
  let high = original.length;
  let best = TRUNCATION_MARKER.trim();
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${original.slice(0, middle)}${TRUNCATION_MARKER}`;
    if (textBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function normalizeHeading(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^[\d.()\s-]+/, '')
    .replace(/[`*_#]/g, '')
    .replace(/[：:]+$/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function sectionKeyForHeading(value) {
  const normalized = normalizeHeading(value);
  return SECTION_SPECS.find((spec) => spec.aliases.includes(normalized))?.key || null;
}

function splitSectionLabel(value) {
  const match = String(value || '').match(/^([^:：]{2,100})[:：]\s*(.*)$/);
  if (!match) return { label: value, content: '' };
  return { label: match[1], content: match[2] };
}

function parseSectionMarker(line) {
  const markdown = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (markdown) {
    const split = splitSectionLabel(markdown[2]);
    return { heading: true, key: sectionKeyForHeading(split.label), content: split.content, level: markdown[1].length };
  }
  const bold = line.match(/^\s*\*\*([^*]+?)\*\*\s*(.*)$/);
  if (bold) {
    const label = bold[1].replace(/[:：]\s*$/, '');
    const key = sectionKeyForHeading(label);
    if (key) return { heading: true, key, content: bold[2].replace(/^[:：]\s*/, '') };
  }
  const split = splitSectionLabel(line.trim());
  const key = sectionKeyForHeading(split.label);
  return key ? { heading: true, key, content: split.content } : null;
}

function extractSections(value) {
  const sections = {};
  let currentKey = null;
  let currentLevel = null;
  for (const line of String(value || '').split(/\r?\n/)) {
    const marker = parseSectionMarker(line);
    if (marker?.heading) {
      if (marker.key) {
        currentKey = marker.key;
        currentLevel = marker.level || null;
        if (marker.content.trim()) sections[currentKey] = [...(sections[currentKey] || []), marker.content.trim()];
      } else if (currentKey && marker.level && currentLevel && marker.level > currentLevel) {
        sections[currentKey] = [...(sections[currentKey] || []), line.trimEnd()];
      } else {
        currentKey = null;
        currentLevel = null;
      }
      continue;
    }
    if (currentKey && line.trim()) sections[currentKey] = [...(sections[currentKey] || []), line.trimEnd()];
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]).filter(([, text]) => text));
}

function compactSection(value, maxBytes, key) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const failurePattern = /\b(?:fail(?:ed|ure)?|error|blocked|timeout|non-zero|exit\s*[1-9])\b|失败|错误|阻塞|超时|未通过/i;
  const ordered = key === 'verificationSummary'
    ? [...lines.filter((line) => failurePattern.test(line)), ...lines.filter((line) => !failurePattern.test(line))]
    : lines;
  const selected = [];
  let omittedLines = 0;
  for (const line of ordered) {
    const candidate = [...selected, line].join('\n');
    if (textBytes(candidate) <= maxBytes) selected.push(line);
    else omittedLines += 1;
  }
  if (selected.length === 0 && ordered.length > 0) {
    selected.push(truncateUtf8(ordered[0], maxBytes));
    omittedLines = Math.max(0, ordered.length - 1);
  }
  return { value: selected.join('\n'), omittedLines };
}

export function buildEvidenceView(text, verificationSummary) {
  const sections = extractSections(text);
  if (Object.keys(sections).length < 2) return null;
  if (verificationSummary) {
    sections.verificationSummary = [String(verificationSummary).trim(), sections.verificationSummary].filter(Boolean).join('\n');
  }
  const view = { evidenceStructured: true };
  const omissions = {};
  for (const spec of SECTION_SPECS) {
    if (!sections[spec.key]) continue;
    const compact = compactSection(sections[spec.key], spec.maxBytes, spec.key);
    view[spec.key] = compact.value;
    if (compact.omittedLines > 0) omissions[spec.key] = compact.omittedLines;
  }
  if (Object.keys(omissions).length > 0) view.evidenceOmissions = omissions;
  return view;
}
