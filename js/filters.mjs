import {DEFAULT_JUMP_TOLERANCE} from './data.mjs?v=26';

// Native range inputs share one track. Each thumb keeps its keyboard and
// accessibility behaviour; the same small control serves filters and dates.
export function paintRange(root) {
  const [low, high] = root.querySelectorAll('input[type=range]');
  const percent = input => (Number(input.value) - Number(input.min)) / Math.max(1, input.max - input.min) * 100;
  root.style.setProperty('--low', `${percent(low)}%`);
  root.style.setProperty('--high', `${percent(high)}%`);
  low.style.zIndex = Number(low.value) > (Number(low.min) + Number(low.max)) / 2 ? '3' : '1';
  high.style.zIndex = '2';
}
export function bindRange(root) {
  root.onpointerdown = event => {
    if (event.target.closest('input')) return;
    const inputs = [...root.querySelectorAll('input[type=range]')];
    if (inputs.some(input => input.disabled)) return;
    const rect = root.getBoundingClientRect(), position = Math.max(0, Math.min(1, (event.clientX - rect.left - 8) / (rect.width - 16)));
    const value = Number(inputs[0].min) + position * (inputs[0].max - inputs[0].min);
    const left = Math.abs(inputs[0].value - value), right = Math.abs(inputs[1].value - value);
    const input = left < right || left === right && value < Number(inputs[0].value) ? inputs[0] : inputs[1];
    input.value = value; input.focus(); input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));
  };
  paintRange(root);
}
export const rangePosition = (value, min, max, logarithmic = false) => max === min ? 0 : (logarithmic ? Math.log1p(value - min) / Math.log1p(max - min) : (value - min) / (max - min)) * 1000;
export const rangeValue = (position, min, max, logarithmic = false) => min + (logarithmic ? Math.expm1(position / 1000 * Math.log1p(max - min)) : position / 1000 * (max - min));

function bindPopover(root, button, panel) {
  panel.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    const rect = button.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight;
    panel.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
    panel.style.top = `${Math.max(8, rect.top >= height + 8 ? rect.top - height - 6 : Math.min(innerHeight - height - 8, rect.bottom + 6))}px`;
  });
  root.append(button, panel);
}

export function createFilters(root, initial, changed, committed) {
  const configs = [
    {id: 'hours', name: 'Hours', unit: 'UTC', minKey: 'hourStart', maxKey: 'hourEnd', bounds: [0, 24], hours: true},
    {id: 'accuracy', name: 'Accuracy', unit: 'm', minKey: 'accuracyMin', maxKey: 'accuracy', unknown: 'accuracyUnknown', bounds: [0, 1000], logarithmic: true},
    {id: 'track', name: 'Track quality'},
    {id: 'speed', name: 'Speed', unit: 'km/h', minKey: 'speedMin', maxKey: 'speedMax', unknown: 'speedUnknown', bounds: [0, 1000], logarithmic: true},
    {id: 'altitude', name: 'Altitude', unit: 'm', minKey: 'altitudeMin', maxKey: 'altitudeMax', unknown: 'altitudeUnknown', bounds: [-500, 9000]},
  ];
  const values = {};
  const number = new Intl.NumberFormat('en', {maximumFractionDigits: 1});
  const clock = value => `${String(value).padStart(2, '0')}:00`;
  function trackQuality(config) {
    values.excludeJumps = initial.excludeJumps === true;
    values.jumpTolerance = initial.jumpTolerance ?? DEFAULT_JUMP_TOLERANCE;
    const button = document.createElement('button'), panel = document.createElement('div');
    button.type = 'button'; button.className = 'filter-toggle'; button.id = 'filter-track'; button.setAttribute('popovertarget', 'filter-track-panel');
    button.title = 'Filter isolated location outliers using nearby movement and track geometry';
    panel.id = 'filter-track-panel'; panel.className = 'filter-popover'; panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'Track quality');
    panel.innerHTML = `<div class="filter-title"><strong>Track quality</strong><button type="button" data-reset>Reset</button></div>
      <button class="filter-toggle" type="button" data-enabled aria-pressed="false">Remove outliers</button>
      <div class="filter-values quality-values"><label>Allowed speed spike<input type="number" min="0" max="200" step="any" aria-label="Allowed speed spike">km/h</label></div>
      <input class="quality-slider" type="range" min="0" max="200" step="1" aria-label="Allowed speed spike slider">
      <p class="hint">Allowance above nearby movement. Lower values filter more. Steady fast travel is retained.</p>`;
    const toggle = panel.querySelector('[data-enabled]'), field = panel.querySelector('input[type=number]'), slider = panel.querySelector('input[type=range]');
    function paint() {
      button.textContent = `Track quality · ${values.excludeJumps ? `+${number.format(values.jumpTolerance)} km/h` : 'Off'}`;
      button.classList.toggle('active', values.excludeJumps);
      toggle.setAttribute('aria-pressed', String(values.excludeJumps));
      field.value = slider.value = values.jumpTolerance;
      slider.setAttribute('aria-valuetext', `${values.jumpTolerance} km/h above nearby movement`);
    }
    const apply = () => { paint(); changed(); committed(); };
    toggle.onclick = () => { values.excludeJumps = !values.excludeJumps; apply(); };
    slider.oninput = () => { values.jumpTolerance = Number(slider.value); values.excludeJumps = true; paint(); };
    slider.onchange = () => { changed(); committed(); };
    field.onchange = () => {
      if (!field.value.trim() || !Number.isFinite(Number(field.value))) { paint(); return; }
      values.jumpTolerance = Math.max(0, Math.min(200, Number(field.value))); values.excludeJumps = true; apply();
    };
    panel.querySelector('[data-reset]').onclick = () => { values.excludeJumps = false; values.jumpTolerance = DEFAULT_JUMP_TOLERANCE; apply(); };
    bindPopover(root, button, panel); paint();
    return {config, paint};
  }
  const controls = configs.map(config => {
    if (config.id === 'track') return trackQuality(config);
    const {id, name, minKey, maxKey, unknown, hours} = config;
    values[minKey] = initial[minKey] ?? (hours ? 0 : null);
    values[maxKey] = initial[maxKey] ?? (hours ? 24 : null);
    if (id === 'accuracy') { values[minKey] ||= null; values[maxKey] ||= null; }
    if (unknown) values[unknown] = initial[unknown] !== false;
    const button = document.createElement('button'), panel = document.createElement('div');
    button.type = 'button'; button.className = 'filter-toggle'; button.id = `filter-${id}`;
    panel.id = `filter-${id}-panel`; panel.className = 'filter-popover'; panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', `${name} range`);
    button.setAttribute('popovertarget', panel.id);
    // Fixed markup; imported data is only ever assigned through value/textContent.
    panel.innerHTML = `<div class="filter-title"><strong>${name} · ${config.unit}</strong><button type="button" data-reset>Reset</button></div>
      <div class="filter-values"><label>From<input data-bound="0" aria-label="Minimum ${name.toLowerCase()}" ${hours ? 'type="text" inputmode="numeric"' : 'type="number" step="any"'}></label><label>To<input data-bound="1" aria-label="Maximum ${name.toLowerCase()}" ${hours ? 'type="text" inputmode="numeric"' : 'type="number" step="any"'}></label></div>
      <div class="dual-range"><input type="range" min="0" max="1000" step="1" aria-label="Minimum ${name.toLowerCase()} slider"><input type="range" min="0" max="1000" step="1" aria-label="Maximum ${name.toLowerCase()} slider"></div>`;
    const fields = [...panel.querySelectorAll('[data-bound]')], sliders = [...panel.querySelectorAll('input[type=range]')], track = panel.querySelector('.dual-range');
    if (hours) for (const slider of sliders) slider.max = 24;
    let toggle;
    if (unknown) {
      toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'filter-toggle'; toggle.textContent = 'Include unknown';
      toggle.onclick = () => { values[unknown] = !values[unknown]; paint(); changed(); committed(); };
      panel.append(toggle);
    }
    const keys = [minKey, maxKey];
    function bounds() {
      return [Math.min(config.bounds[0], values[minKey] ?? Infinity), Math.max(config.bounds[1], values[maxKey] ?? -Infinity)];
    }
    function paint() {
      const [min, max] = bounds(), pair = [values[minKey] ?? min, values[maxKey] ?? max];
      fields.forEach((field, i) => { field.value = hours ? clock(pair[i]) : values[keys[i]] === null ? '' : Number(pair[i].toPrecision(6)); field.placeholder = 'Any'; });
      sliders.forEach((slider, i) => { slider.value = hours ? pair[i] : rangePosition(pair[i], min, max, config.logarithmic); slider.setAttribute('aria-valuetext', `${hours ? clock(pair[i]) : number.format(pair[i])} ${config.unit}`); });
      paintRange(track);
      const active = hours ? pair[0] !== 0 || pair[1] !== 24 : values[minKey] !== null || values[maxKey] !== null || values[unknown] === false;
      const low = values[minKey], high = values[maxKey], format = value => hours ? clock(value) : value !== 0 && Math.abs(value) < 1 ? new Intl.NumberFormat('en', {maximumSignificantDigits: 3}).format(value) : number.format(value);
      const caption = hours ? `${clock(low)}–${clock(high)}` : low === null && high === null ? 'All' : low === null ? `${id === 'accuracy' ? '<' : '≤'}${format(high)} ${config.unit}` : high === null ? `≥${format(low)} ${config.unit}` : `${format(low)}–${format(high)} ${config.unit}`;
      button.textContent = `${name} · ${active ? caption : 'All'}${!hours && values[unknown] === false ? ' · known' : ''}`;
      button.classList.toggle('active', active);
      button.title = `${name} range${unknown ? '. Unknown values are included unless disabled in this filter.' : ''}`;
      toggle?.setAttribute('aria-pressed', String(values[unknown]));
    }
    function set(i, value, slider = false) {
      const [min, max] = bounds(), other = values[keys[1 - i]] ?? (i ? min : max);
      if (hours) value = Math.max(0, Math.min(24, Math.round(value)));
      if (value !== null) value = i ? Math.max(other + (hours ? 1 : 0), value) : Math.min(other - (hours ? 1 : 0), value);
      values[keys[i]] = !hours && slider && (i ? value >= max : value <= min) ? null : value;
      paint(); changed();
    }
    sliders.forEach((slider, i) => {
      slider.oninput = () => { const [min, max] = bounds(); set(i, hours ? Number(slider.value) : rangeValue(Number(slider.value), min, max, config.logarithmic), true); };
      slider.onchange = committed;
    });
    fields.forEach((field, i) => { field.onchange = () => {
      const text = field.value.trim(), value = hours ? /^\d{1,2}(?::00)?$/.test(text) ? Number(text.split(':')[0]) : NaN : text === '' ? null : Number(text);
      if (value !== null && (!Number.isFinite(value) || !hours && (id !== 'altitude' && value < 0 || Math.abs(value) > 1e6) || hours && (value < 0 || value > 24))) { paint(); return; }
      set(i, value); committed();
    }; });
    panel.querySelector('[data-reset]').onclick = () => { values[minKey] = hours ? 0 : null; values[maxKey] = hours ? 24 : null; if (unknown) values[unknown] = true; paint(); changed(); committed(); };
    bindPopover(root, button, panel); bindRange(track); paint();
    return {config, paint};
  });
  return {
    values: () => ({...values, accuracy: values.accuracy ?? 0, accuracyMin: values.accuracyMin ?? 0}),
    setHours(start, end) { values.hourStart = start; values.hourEnd = end; controls[0].paint(); },
    setBounds(ranges = {}) { for (const {config, paint} of controls) { const range = ranges[config.id]; if (range?.every(Number.isFinite)) { config.bounds = [Math.floor(range[0]), Math.max(Math.floor(range[0]) + 1, Math.ceil(range[1]))]; paint(); } } },
  };
}
