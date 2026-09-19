export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>ZeroClave Telemetry</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#f4f5f7; color:#17191c; }
    * { box-sizing:border-box; }
    body { margin:0; }
    header { background:#111315; color:#fff; border-bottom:3px solid #36c98f; }
    header div, main { width:min(1180px, calc(100% - 32px)); margin:0 auto; }
    header div { min-height:64px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
    h1 { margin:0; font-size:18px; font-weight:650; letter-spacing:0; }
    main { padding:24px 0 48px; }
    .toolbar { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
    .toolbar p { margin:0; color:#5c626b; font-size:13px; }
    select { min-height:36px; border:1px solid #c7cbd1; background:white; padding:0 32px 0 10px; border-radius:5px; }
    .cards { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:12px; margin-bottom:20px; }
    .card { background:white; border:1px solid #dfe2e6; border-radius:6px; padding:16px; }
    .label { color:#697079; font-size:12px; text-transform:uppercase; }
    .metric { margin-top:8px; font-size:30px; font-weight:650; font-variant-numeric:tabular-nums; }
    section { background:white; border:1px solid #dfe2e6; border-radius:6px; margin-top:12px; overflow:hidden; }
    section h2 { font-size:14px; margin:0; padding:14px 16px; border-bottom:1px solid #e6e8eb; }
    .chart { padding:16px; display:grid; gap:8px; }
    .bar-row { display:grid; grid-template-columns:88px 1fr 64px; align-items:center; gap:10px; font-size:12px; }
    .bar-track { height:10px; background:#eceff1; border-radius:2px; overflow:hidden; }
    .bar { height:100%; background:#168a63; }
    .number { text-align:right; font-variant-numeric:tabular-nums; }
    .table-wrap { overflow:auto; }
    table { border-collapse:collapse; width:100%; font-size:12px; }
    th, td { padding:10px 12px; border-bottom:1px solid #eceef0; text-align:left; white-space:nowrap; }
    th { background:#f7f8f9; color:#555c64; font-weight:600; }
    td:last-child, th:last-child { text-align:right; }
    .state { padding:28px 16px; color:#697079; }
    @media (max-width:700px) { .cards { grid-template-columns:1fr; } .toolbar { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header><div><h1>ZeroClave Telemetry</h1><span>Privacy-minimized aggregates</span></div></header>
  <main>
    <div class="toolbar">
      <p id="range-label">Loading aggregate data...</p>
      <label>Range <select id="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label>
    </div>
    <div class="cards">
      <div class="card"><div class="label">Latest DAU</div><div class="metric" id="latest-dau">-</div></div>
      <div class="card"><div class="label">Average DAU</div><div class="metric" id="average-dau">-</div></div>
      <div class="card"><div class="label">Protected sends, latest day</div><div class="metric" id="protected-sends">-</div></div>
    </div>
    <section><h2>Daily active profiles</h2><div class="chart" id="chart"><div class="state">Loading...</div></div></section>
    <section><h2>Event breakdown</h2><div class="table-wrap"><table><thead><tr><th>Day</th><th>Event</th><th>Value</th><th>Version</th><th>Profiles</th></tr></thead><tbody id="breakdown"></tbody></table></div></section>
  </main>
  <script src="/admin/app.js" defer></script>
</body>
</html>`;

export const ADMIN_JS = `
'use strict';
const daysSelect = document.querySelector('#days');
const integer = new Intl.NumberFormat('en-US');

function setText(selector, value) {
  document.querySelector(selector).textContent = String(value);
}

function cell(row, value) {
  const item = document.createElement('td');
  item.textContent = String(value);
  row.append(item);
}

async function load() {
  const days = daysSelect.value;
  const response = await fetch('/admin/api/summary?days=' + encodeURIComponent(days), {
    credentials: 'same-origin',
    headers: { accept: 'application/json' }
  });
  if (!response.ok) throw new Error('summary_unavailable');
  render(await response.json());
}

function render(data) {
  const active = data.rows.filter((row) => row.event === 'privacy_active' && row.value === '*' && row.plugin_version === '*');
  const latest = active.at(-1);
  const average = Math.round(active.reduce((sum, row) => sum + row.unique_profiles, 0) / data.range.days);
  const protectedRow = data.rows.find((row) =>
    latest && row.day === latest.day && row.event === 'protected_send' && row.value === '*' && row.plugin_version === '*'
  );

  setText('#range-label', data.range.from + ' to ' + data.range.to + ' (UTC)');
  setText('#latest-dau', integer.format(latest ? latest.unique_profiles : 0));
  setText('#average-dau', integer.format(average));
  setText('#protected-sends', integer.format(protectedRow ? protectedRow.unique_profiles : 0));

  const chart = document.querySelector('#chart');
  chart.replaceChildren();
  const maximum = Math.max(1, ...active.map((row) => row.unique_profiles));
  for (const item of active) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const day = document.createElement('span');
    day.textContent = item.day.slice(5);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = Math.max(1, item.unique_profiles / maximum * 100) + '%';
    track.append(bar);
    const count = document.createElement('span');
    count.className = 'number';
    count.textContent = integer.format(item.unique_profiles);
    row.append(day, track, count);
    chart.append(row);
  }
  if (!active.length) {
    const empty = document.createElement('div');
    empty.className = 'state';
    empty.textContent = 'No data in this range.';
    chart.append(empty);
  }

  const detail = data.rows.filter((row) => row.event !== '*' && row.value !== '*' && row.plugin_version !== '*');
  const body = document.querySelector('#breakdown');
  body.replaceChildren();
  for (const item of detail.slice().reverse()) {
    const row = document.createElement('tr');
    cell(row, item.day);
    cell(row, item.event);
    cell(row, item.value || '-');
    cell(row, item.plugin_version);
    cell(row, integer.format(item.unique_profiles));
    body.append(row);
  }
}

daysSelect.addEventListener('change', () => load().catch(showError));
load().catch(showError);

function showError() {
  setText('#range-label', 'Aggregate data is unavailable.');
  const chart = document.querySelector('#chart');
  chart.textContent = '';
  const message = document.createElement('div');
  message.className = 'state';
  message.textContent = 'Unable to load the dashboard.';
  chart.append(message);
}
`;
