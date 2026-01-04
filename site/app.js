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

const SERVICES = [
  'Git Operations',
  'Webhooks',
  'API Requests',
  'Issues',
  'Pull Requests',
  'Actions',
  'Packages',
  'Pages',
  'Codespaces',
  'Copilot',
];


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

const incidentStartDate = (incident) =>
  incident.downtime_start ? new Date(incident.downtime_start) : new Date(incident.published_at);

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
  const incidentById = new Map();
  incidents.forEach((incident) => {
    if (incident.id) {
      incidentById.set(String(incident.id), incident);
    }
  });

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
          const fullIncident = incidentById.get(String(row.incident_id || '')) || null;
          if (!existing || (impactRank[impact] ?? 0) > (impactRank[existing.impact] ?? 0)) {
            dayIncidents[index].set(incidentId, {
              id: incidentId,
              title: fullIncident?.title || row.title || 'Incident',
              impact,
              duration: row.duration_minutes || null,
              url: fullIncident?.url || null,
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

  const attachTooltip = (bars, tooltip, container, severityByDay, incidentsByDay) => {
    let hideTimeout = null;

    const positionTooltip = (target) => {
      const panelRect = container.getBoundingClientRect();
      const barRect = target.getBoundingClientRect();
      const tooltipRect = tooltip.getBoundingClientRect();
      const padding = 12;
      let left = barRect.left - panelRect.left + barRect.width / 2;
      left = Math.max(
        tooltipRect.width / 2 + padding,
        Math.min(left, panelRect.width - tooltipRect.width / 2 - padding),
      );
      let top = barRect.top - panelRect.top - tooltipRect.height - 12;
      if (top < padding) {
        top = barRect.bottom - panelRect.top + 12;
      }
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      const tooltipLeft = left - tooltipRect.width / 2;
      const arrowLeft = barRect.left - panelRect.left + barRect.width / 2 - tooltipLeft;
      tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`);
      tooltip.dataset.arrow = 'top';
    };

    const showTooltip = (target) => {
      if (hideTimeout) {
        window.clearTimeout(hideTimeout);
        hideTimeout = null;
      }
      const index = Number(target.dataset.dayIndex || 0);
      const date = new Date(rangeStart.getTime() + index * 86400000);
      const incidents = Array.from(incidentsByDay[index]?.values() || []);
      const severity = severityByDay[index] ?? 0;
      const impact = severityToImpact(severity);

      const incidentMarkup = incidents.length
        ? `<ul class=\"tooltip-incidents\">${incidents
            .slice(0, 4)
            .map((item) => {
              const title = item.title;
              if (item.url) {
                return `<li><a href=\"${item.url}\" target=\"_blank\" rel=\"noreferrer\">${title}</a></li>`;
              }
              return `<li>${title}</li>`;
            })
            .join('')}</ul>`
        : '<p class=\"tooltip-incidents\">No incidents recorded.</p>';

      tooltip.innerHTML = `
        <div class=\"tooltip-date\">${formatDate(date)}</div>
        <div class=\"tooltip-impact\">
          <span class=\"tooltip-dot ${impact}\"></span>
          ${impactLabel[impact] || 'Operational'}
        </div>
        ${incidentMarkup}
      `;
      tooltip.classList.add('active');
      tooltip.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => positionTooltip(target));
    };

    const hideTooltip = () => {
      tooltip.classList.remove('active');
      tooltip.setAttribute('aria-hidden', 'true');
    };

    const scheduleHide = () => {
      if (hideTimeout) window.clearTimeout(hideTimeout);
      hideTimeout = window.setTimeout(() => {
        hideTooltip();
      }, 120);
    };

    bars.querySelectorAll('span').forEach((bar) => {
      bar.addEventListener('mouseenter', () => showTooltip(bar));
      bar.addEventListener('focus', () => showTooltip(bar));
      bar.addEventListener('mouseleave', scheduleHide);
      bar.addEventListener('blur', scheduleHide);
    });

    tooltip.addEventListener('mouseenter', () => {
      if (hideTimeout) window.clearTimeout(hideTimeout);
    });

    tooltip.addEventListener('mouseleave', scheduleHide);
  };

  attachTooltip(uptimeBars, uptimeTooltip, heroPanel, daySeverity, dayIncidents);

  const lastUpdated = incidents[0]?.updated_at ? new Date(incidents[0].updated_at) : now;
  document.getElementById('lastUpdated').textContent = `Last updated ${formatDate(lastUpdated)}`;

  const since = rangeStart.getTime();
  const recentIncidents = incidents.filter((incident) => {
    const start = incidentStartDate(incident).getTime();
    return start >= since;
  });
  document.getElementById('incidentCount').textContent = `${recentIncidents.length} incidents in last 90 days`;

  const serviceStatus = document.getElementById('serviceStatus');
  serviceStatus.innerHTML = '';

  const serviceStats = SERVICES.map((service) => ({
    name: service,
    daySeverity: new Array(90).fill(0),
    dayIncidents: Array.from({ length: 90 }, () => new Map()),
    intervals: [],
  }));

  const serviceIndex = new Map(serviceStats.map((item, index) => [item.name, index]));

  incidents.forEach((incident) => {
    if (!incident.components || !incident.components.length) return;
    if (!incident.downtime_start || !incident.downtime_end) return;
    const start = new Date(incident.downtime_start);
    const end = new Date(incident.downtime_end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return;
    const impact = incident.impact || 'none';
    incident.components.forEach((component) => {
      if (!serviceIndex.has(component)) return;
      const clipped = clipInterval(start, end, rangeStart, rangeEnd);
      if (!clipped) return;
      const stat = serviceStats[serviceIndex.get(component)];
      stat.intervals.push(clipped);
      let current = getDayStartUTC(clipped[0]);
      const lastDay = getDayStartUTC(clipped[1]);
      while (current <= lastDay) {
        const index = Math.floor((current - rangeStart) / 86400000);
        if (index >= 0 && index < stat.daySeverity.length) {
          stat.daySeverity[index] = Math.max(stat.daySeverity[index], impactRank[impact] ?? 0);
          const existing = stat.dayIncidents[index].get(incident.id);
          if (!existing || (impactRank[impact] ?? 0) > (impactRank[existing.impact] ?? 0)) {
            stat.dayIncidents[index].set(incident.id, {
              id: incident.id,
              title: incident.title,
              impact,
              url: incident.url,
            });
          }
        }
        current = new Date(current.getTime() + 86400000);
      }
    });
  });

  serviceStats.forEach((stat) => {
    const merged = mergeIntervals(stat.intervals);
    const downtimeMs = merged.reduce((sum, [start, end]) => sum + (end - start), 0);
    const totalMs = 90 * 24 * 60 * 60 * 1000;
    stat.uptime = Math.max(0, 1 - downtimeMs / totalMs);
  });

  serviceStats.forEach((stat) => {
    const row = document.createElement('div');
    row.className = 'service-row';

    const header = document.createElement('div');
    header.className = 'service-row-header';
    const name = document.createElement('strong');
    name.textContent = stat.name;
    const uptimeValue = document.createElement('span');
    uptimeValue.textContent = `${(stat.uptime * 100).toFixed(2)}% uptime`;
    header.appendChild(name);
    header.appendChild(uptimeValue);
    row.appendChild(header);

    const bars = document.createElement('div');
    bars.className = 'service-bars';
    stat.daySeverity.forEach((severity, index) => {
      const span = document.createElement('span');
      const impact = Object.keys(impactRank).find((key) => impactRank[key] === severity) || 'none';
      span.className = impact === 'none' ? 'operational' : impact;
      span.dataset.dayIndex = String(index);
      span.tabIndex = 0;
      bars.appendChild(span);
    });
    row.appendChild(bars);

    const tooltip = document.createElement('div');
    tooltip.className = 'uptime-tooltip service-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    row.appendChild(tooltip);

    attachTooltip(bars, tooltip, row, stat.daySeverity, stat.dayIncidents);

    serviceStatus.appendChild(row);
  });

  const timeline = document.getElementById('incidentTimeline');
  timeline.innerHTML = '';

  const grouped = new Map();
  incidents.forEach((incident) => {
    const date = formatDate(incidentStartDate(incident));
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
  const start = incidentStartDate(incident);
  meta.textContent = `${formatTime(start)} UTC • ${incident.duration_minutes ?? '—'} min impact`;
  card.appendChild(meta);

  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  (incident.status_sequence || []).forEach((status) => {
    const pill = document.createElement('span');
    pill.textContent = status;
    timeline.appendChild(pill);
  });
  card.appendChild(timeline);

  if (incident.components && incident.components.length) {
    const componentRow = document.createElement('div');
    componentRow.className = 'components';
    incident.components.slice(0, 4).forEach((component) => {
      const tag = document.createElement('span');
      tag.textContent = component;
      componentRow.appendChild(tag);
    });
    if (incident.components.length > 4) {
      const more = document.createElement('span');
      more.textContent = `+${incident.components.length - 4} more`;
      componentRow.appendChild(more);
    }
    card.appendChild(componentRow);
  }

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
