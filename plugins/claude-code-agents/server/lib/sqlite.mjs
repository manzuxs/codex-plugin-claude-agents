let DatabaseSync;
try {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = function scopedSqliteWarning(warning, ...args) {
    if (args[0] === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
    return originalEmitWarning.call(this, warning, ...args);
  };
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.emitWarning = originalEmitWarning;
  }
} catch {
  throw new Error('SQLite storage requires Node.js 22.5 or newer (node:sqlite).');
}

export { DatabaseSync };
