// Claude subscription usage. Shows whichever window (5-hour or 7-day) is closer to its limit.
export function claudeWindow(usage) {
  const windows = [[usage?.five_hour, 18_000], [usage?.seven_day, 604_800]]
    .filter(([window]) => Number.isFinite(window?.utilization));
  if (!windows.length) return null;
  const [window, seconds] = windows.reduce((a, b) => (b[0].utilization > a[0].utilization ? b : a));
  return {
    quotaUsed: window.utilization,
    quotaRemaining: Math.max(0, 100 - window.utilization),
    windowSeconds: seconds,
    resetAt: window.resets_at ? new Date(window.resets_at).toISOString() : null
  };
}
