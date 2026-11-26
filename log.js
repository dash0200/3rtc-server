/** One-line timestamped log: [2026-10-14 03:06:52] [LEVEL] message */
export function log(level, message) {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [${level}] ${message}`);
}
