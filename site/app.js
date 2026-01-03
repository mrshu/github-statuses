const DATA_ROOT = window.location.pathname.includes('/site/') ? '../parsed' : 'parsed';
const INCIDENTS_URL = `${DATA_ROOT}/incidents.jsonl`;
const WINDOWS_URL = `${DATA_ROOT}/downtime_windows.csv`;

const impactRank = {
  none: 0,
  maintenance: 1,
  minor: 2,
  major: 3,
};

const impactLabel = {
  none: 'Operational',
  maintenance: 'Maintenance',
  minor: 'Minor',
  major: 'Major',
};

const statusLabel = {
  none: 'Archive only',
  maintenance: 'Maintenance recorded',
  minor: 'Recent minor impact',
  major: 'Recent major impact',
};

const formatDate = (date) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);

const formatTime = (date) =>
  new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);

const parseJSONL = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const parseCSVLine = (line) => {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
};

const parseCSV = (text) => {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const headers = parseCSVLine(lines.shift());
  return lines.map((line) => {
    const cols = parseCSVLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] ?? '';
    });
    return row;
  });
};

const getDayStartUTC = (date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const clipInterval = (start, end, rangeStart, rangeEnd) => {
  const startMs = Math.max(start.getTime(), rangeStart.getTime());
  const endMs = Math.min(end.getTime(), rangeEnd.getTime());
  if (endMs <= startMs) return null;
  return [new Date(startMs), new Date(endMs)];
};

const mergeIntervals = (intervals) => {
  if (!intervals.length) return [];
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = merged[merged.length - 1];
    const current = sorted[i];
    if (current[0] <= last[1]) {
      last[1] = new Date(Math.max(last[1].getTime(), current[1].getTime()));
    } else {
      merged.push(current);
    }
  }
  return merged;
};

const render = async () => {
  const [incidentsText, windowsText] = await Promise.all([
    fetch(INCIDENTS_URL).then((res) => res.text()),
    fetch(WINDOWS_URL).then((res) => res.text()),
  ]);

  const incidents = parseJSONL(incidentsText);
  const windows = parseCSV(windowsText);

  incidents.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  const now = new Date();
  const today = getDayStartUTC(now);
  const rangeStart = new Date(today);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 89);
  const rangeEnd = new Date(today);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1);

  const daySeverity = new Array(90).fill(0);
  const dayIncidents = Array.from({ length: 90 }, () => new Map());
  const clippedIntervals = [];

  windows.forEach((row) => {
    if (!row.downtime_start || !row.downtime_end) return;
    const start = new Date(row.downtime_start);
    const end = new Date(row.downtime_end);
    if (Number.isNaN(start) || Number.isNaN(end)) return;
    const clipped = clipInterval(start, end, rangeStart, rangeEnd);
    if (!clipped) return;
    const impact = row.impact || 'none';
    clippedIntervals.push(clipped);

    let current = getDayStartUTC(clipped[0]);
    const lastDay = getDayStartUTC(clipped[1]);
    while (current <= lastDay) {
      const index = Math.floor((current - rangeStart) / 86400000);
      if (index >= 0 && index < daySeverity.length) {
        daySeverity[index] = Math.max(daySeverity[index], impactRank[impact] ?? 0);
        const incidentId = row.incident_id || row.title;
        if (incidentId) {
          const existing = dayIncidents[index].get(incidentId);
          if (!existing || (impactRank[impact] ?? 0) > (impactRank[existing.impact] ?? 0)) {
            dayIncidents[index].set(incidentId, {
              id: incidentId,
              title: row.title || 'Incident',
              impact,
              duration: row.duration_minutes || null,
            });
          }
        }
      }
      current = new Date(current.getTime() + 86400000);
    }
  });

  const merged = mergeIntervals(clippedIntervals);
  const downtimeMs = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
  const totalMs = 90 * 24 * 60 * 60 * 1000;
  const uptime = Math.max(0, 1 - downtimeMs / totalMs);

  const uptimePercent = document.getElementById('uptimePercent');
  uptimePercent.textContent = `${(uptime * 100).toFixed(2)}% uptime`;

  const uptimeBars = document.getElementById('uptimeBars');
  const uptimeTooltip = document.getElementById('uptimeTooltip');
  const heroPanel = document.querySelector('.hero-panel');
  uptimeBars.innerHTML = '';
  uptimeTooltip.classList.remove('active');

  daySeverity.forEach((severity, index) => {
    const span = document.createElement('span');
    const impact = Object.keys(impactRank).find((key) => impactRank[key] === severity) || 'none';
    span.className = impact === 'none' ? 'operational' : impact;
    span.dataset.dayIndex = String(index);
    span.tabIndex = 0;
    uptimeBars.appendChild(span);
  });

  const severityToImpact = (severity) =>
    Object.keys(impactRank).find((key) => impactRank[key] === severity) || 'none';

  const positionTooltip = (target) => {
    const panelRect = heroPanel.getBoundingClientRect();
    const barRect = target.getBoundingClientRect();
    const tooltipRect = uptimeTooltip.getBoundingClientRect();
    const padding = 12;
    let left = barRect.left - panelRect.left + barRect.width / 2;
    left = Math.max(tooltipRect.width / 2 + padding, Math.min(left, panelRect.width - tooltipRect.width / 2 - padding));
    let top = barRect.top - panelRect.top - tooltipRect.height - 12;
    if (top < padding) {
      top = barRect.bottom - panelRect.top + 12;
    }
    uptimeTooltip.style.left = `${left}px`;
    uptimeTooltip.style.top = `${top}px`;
  };

  const showTooltip = (target) => {
    const index = Number(target.dataset.dayIndex || 0);
    const date = new Date(rangeStart.getTime() + index * 86400000);
    const incidents = Array.from(dayIncidents[index]?.values() || []);
    const severity = daySeverity[index] ?? 0;
    const impact = severityToImpact(severity);

    const incidentMarkup = incidents.length
      ? `<ul class=\"tooltip-incidents\">${incidents
          .slice(0, 4)
          .map((item) => `<li>${item.title}</li>`)
          .join('')}</ul>`
      : '<p class=\"tooltip-incidents\">No incidents recorded.</p>';

    uptimeTooltip.innerHTML = `
      <div class=\"tooltip-date\">${formatDate(date)}</div>
      <div class=\"tooltip-impact\">
        <span class=\"tooltip-dot ${impact}\"></span>
        ${impactLabel[impact] || 'Operational'}
      </div>
      ${incidentMarkup}
    `;
    uptimeTooltip.classList.add('active');
    uptimeTooltip.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => positionTooltip(target));
  };

  const hideTooltip = () => {
    uptimeTooltip.classList.remove('active');
    uptimeTooltip.setAttribute('aria-hidden', 'true');
  };

  uptimeBars.querySelectorAll('span').forEach((bar) => {
    bar.addEventListener('mouseenter', () => showTooltip(bar));
    bar.addEventListener('focus', () => showTooltip(bar));
    bar.addEventListener('mouseleave', hideTooltip);
    bar.addEventListener('blur', hideTooltip);
    bar.addEventListener('click', () => {
      if (uptimeTooltip.classList.contains('active')) {
        hideTooltip();
      } else {
        showTooltip(bar);
      }
    });
  });

  const lastUpdated = incidents[0]?.updated_at ? new Date(incidents[0].updated_at) : now;
  document.getElementById('lastUpdated').textContent = `Last updated ${formatDate(lastUpdated)}`;

  const since = rangeStart.getTime();
  const recentIncidents = incidents.filter((incident) => {
    const published = new Date(incident.published_at).getTime();
    return published >= since;
  });
  document.getElementById('incidentCount').textContent = `${recentIncidents.length} incidents in last 90 days`;

  const latestIncident = incidents[0];
  const latestImpact = latestIncident?.impact || 'none';
  const status = latestImpact;

  const statusBadge = document.getElementById('statusBadge');
  statusBadge.className = `status-pill ${status}`;
  statusBadge.textContent = statusLabel[status] || statusLabel.none;

  const statusHeadline = document.getElementById('statusHeadline');
  const statusMessage = document.getElementById('statusMessage');
  if (latestIncident) {
    const latestDate = formatDate(new Date(latestIncident.published_at));
    statusHeadline.textContent = `Latest recorded impact: ${impactLabel[status] || 'Operational'}`;
    statusMessage.textContent = `Last incident logged on ${latestDate}. This mirror reflects archived status history, not live monitoring.`;
  } else {
    statusHeadline.textContent = 'No incidents recorded';
    statusMessage.textContent = 'This mirror reflects archived status history, not live monitoring.';
  }

  const timeline = document.getElementById('incidentTimeline');
  timeline.innerHTML = '';

  const grouped = new Map();
  incidents.forEach((incident) => {
    const date = formatDate(new Date(incident.published_at));
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(incident);
  });

  const entries = Array.from(grouped.entries());
  let showAll = false;

  const renderTimeline = () => {
    timeline.innerHTML = '';
    const slice = showAll ? entries : entries.slice(0, 8);
    slice.forEach(([date, list]) => {
      const group = document.createElement('div');
      group.className = 'incident-group';

      const heading = document.createElement('h4');
      heading.textContent = date;
      group.appendChild(heading);

      list.forEach((incident) => {
        group.appendChild(renderIncidentCard(incident));
      });

      timeline.appendChild(group);
    });
  };

  renderTimeline();

  document.getElementById('togglePast').addEventListener('click', () => {
    showAll = !showAll;
    document.getElementById('togglePast').textContent = showAll ? 'Show fewer' : 'Show more';
    renderTimeline();
  });
};

const renderIncidentCard = (incident, compact = false) => {
  const card = document.createElement('div');
  card.className = 'incident-card';

  const titleRow = document.createElement('div');
  titleRow.className = 'incident-title';

  const title = document.createElement('h5');
  const link = document.createElement('a');
  link.href = incident.url || '#';
  link.textContent = incident.title || 'Incident';
  link.target = '_blank';
  link.rel = 'noreferrer';
  title.appendChild(link);
  titleRow.appendChild(title);

  const badge = document.createElement('span');
  const impact = incident.impact || 'none';
  badge.className = `badge ${impact}`;
  badge.textContent = impactLabel[impact] || 'Operational';
  titleRow.appendChild(badge);

  card.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'incident-meta';
  const published = new Date(incident.published_at);
  meta.textContent = `${formatTime(published)} UTC • ${incident.duration_minutes ?? '—'} min impact`;
  card.appendChild(meta);

  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  (incident.status_sequence || []).forEach((status) => {
    const pill = document.createElement('span');
    pill.textContent = status;
    timeline.appendChild(pill);
  });
  card.appendChild(timeline);

  if (!compact) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'View updates';
    details.appendChild(summary);

    const list = document.createElement('ul');
    (incident.updates || []).forEach((update) => {
      const li = document.createElement('li');
      const time = new Date(update.at);
      li.textContent = `${formatTime(time)} UTC · ${update.status} — ${update.message}`;
      list.appendChild(li);
    });
    details.appendChild(list);
    card.appendChild(details);
  }

  return card;
};

render().catch((error) => {
  console.error(error);
  const status = document.getElementById('statusHeadline');
  if (status) status.textContent = 'Unable to load incident data.';
});
