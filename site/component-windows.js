const componentWindows = (() => {
  const toInterval = (start, end) => {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
      return null;
    }
    return [startDate, endDate];
  };

  // The windows during which `component` was affected by `incident`. A component the
  // status page marked degraded and later recovered has its own windows, which can be
  // much shorter than an incident kept open for a backlog. Without any, fall back to
  // the incident's own window.
  const forIncident = (incident, component) => {
    const own = (incident.component_windows || [])
      .filter((window) => window.component === component)
      .map((window) => toInterval(window.start_at, window.end_at))
      .filter(Boolean);
    if (own.length) return own;
    const whole = toInterval(incident.downtime_start, incident.downtime_end);
    return whole ? [whole] : [];
  };

  return { forIncident };
})();

if (typeof module !== 'undefined') {
  module.exports = componentWindows;
}
