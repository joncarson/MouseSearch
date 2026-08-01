// ============================================================
// Scheduled Searches UI
// Manages saved searches that run on a cron schedule and
// auto-grab new results (see templates/modals/scheduled_searches.html).
// ============================================================

(function () {
    'use strict';

    const BASE = (window.APP_BASE || '').replace(/\/+$/, '');
    const API_URL = `${BASE}/api/scheduled_searches`;

    const SEARCH_IN_FIELDS = ['title', 'author', 'series', 'narrator', 'description', 'tags', 'filenames'];

    let entriesById = {};
    let editingEntry = null; // carries fields not exposed in the form (category_ids, flag_ids, ...)
    let langTomSelect = null;
    let listLoaded = false;

    // ---------- Helpers ----------

    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    function notify(message, type = 'primary') {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
            return;
        }
        const container = document.getElementById('ss-alert-container');
        if (!container) return;
        container.innerHTML = `
            <div class="alert alert-${esc(type)} alert-dismissible small" role="alert">
                ${esc(message)}
                <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
            </div>`;
    }

    function formatDate(iso) {
        if (!iso) return null;
        const date = new Date(iso);
        if (isNaN(date.getTime())) return null;
        return date.toLocaleString([], {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit'
        });
    }

    function statusBadge(entry) {
        const state = entry.state || {};
        if (state.running) {
            return `<span class="badge text-bg-info ms-1">
                        <span class="spinner-border spinner-border-sm me-1" style="width:.7rem;height:.7rem;"
                            role="status" aria-hidden="true"></span>Running
                    </span>`;
        }
        return entry.enabled
            ? '<span class="badge text-bg-success ms-1">Enabled</span>'
            : '<span class="badge text-bg-secondary ms-1">Disabled</span>';
    }

    // ---------- List rendering ----------

    async function loadList() {
        const loading = document.getElementById('ss-list-loading');
        if (!listLoaded && loading) loading.classList.remove('d-none');
        try {
            const response = await fetch(API_URL, { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to load scheduled searches.');
            renderList(data.scheduled_searches || []);
            listLoaded = true;
        } catch (error) {
            notify(error.message || 'Failed to load scheduled searches.', 'danger');
        } finally {
            if (loading) loading.classList.add('d-none');
        }
    }

    function renderList(entries) {
        entriesById = {};
        const list = document.getElementById('ss-list');
        const empty = document.getElementById('ss-list-empty');
        if (!list) return;

        list.innerHTML = '';
        if (empty) empty.classList.toggle('d-none', entries.length > 0);

        entries.forEach(entry => {
            entriesById[entry.id] = entry;
            list.appendChild(buildEntryCard(entry));
        });
    }

    function buildEntryCard(entry) {
        const state = entry.state || {};
        const card = document.createElement('div');
        card.className = 'card mb-2 border-secondary-subtle';
        card.dataset.ssId = entry.id;

        const nextRun = formatDate(state.next_run);
        const lastRun = formatDate(state.last_run);

        let lastRunLine = 'Never run';
        if (lastRun) {
            const statusIcon = state.last_status === 'ok'
                ? '<i class="bi bi-check-circle-fill text-success me-1"></i>'
                : (state.last_status ? '<i class="bi bi-exclamation-triangle-fill text-warning me-1"></i>' : '');
            const counts = [];
            if (state.last_found != null) counts.push(`found ${state.last_found}`);
            if (state.last_new != null) counts.push(`new ${state.last_new}`);
            if (state.last_grabbed != null) counts.push(`grabbed ${state.last_grabbed}`);
            lastRunLine = `${statusIcon}Last run ${esc(lastRun)}${counts.length ? ' &mdash; ' + counts.join(', ') : ''}`;
        }

        const errors = Array.isArray(state.last_errors) ? state.last_errors : [];
        const errorButton = errors.length
            ? `<button type="button" class="btn btn-link btn-sm p-0 text-danger align-baseline ms-1"
                   data-bs-toggle="collapse" data-bs-target="#ss-errors-${esc(entry.id)}"
                   title="Show last run errors" aria-expanded="false" aria-controls="ss-errors-${esc(entry.id)}">
                   <i class="bi bi-exclamation-circle-fill"></i> ${errors.length}
               </button>`
            : '';
        const errorCollapse = errors.length
            ? `<div class="collapse" id="ss-errors-${esc(entry.id)}">
                   <div class="alert alert-danger small mt-2 mb-0 py-2">
                       <ul class="mb-0 ps-3">${errors.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
                   </div>
               </div>`
            : '';

        card.innerHTML = `
            <div class="card-body py-2 px-3">
                <div class="d-flex justify-content-between align-items-start gap-2">
                    <div class="me-auto">
                        <span class="fw-bold">${esc(entry.name)}</span>
                        ${statusBadge(entry)}
                        ${errorButton}
                        <div class="small text-body-secondary">
                            <code>${esc(entry.cron)}</code>
                            ${entry.query ? ` &middot; <span class="fst-italic">${esc(entry.query)}</span>` : ''}
                        </div>
                    </div>
                    <div class="form-check form-switch m-0 pt-1" title="${entry.enabled ? 'Disable' : 'Enable'} this search">
                        <input class="form-check-input ss-toggle" type="checkbox" role="switch"
                            aria-label="Enable or disable" ${entry.enabled ? 'checked' : ''}>
                    </div>
                </div>
                <div class="small text-body-secondary mt-1">
                    ${nextRun ? `<div><i class="bi bi-clock me-1"></i>Next run ${esc(nextRun)}</div>` : ''}
                    <div>${lastRunLine}</div>
                    <div>Total grabbed: ${Number(state.total_grabbed || 0)}</div>
                </div>
                ${errorCollapse}
                <div class="d-flex gap-2 mt-2">
                    <button type="button" class="btn btn-sm btn-outline-primary ss-run" ${state.running ? 'disabled' : ''}>
                        ${state.running
                            ? '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Running...'
                            : '<i class="bi bi-play-fill"></i> Run now'}
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-secondary ss-edit">
                        <i class="bi bi-pencil"></i> Edit
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger ms-auto ss-delete" title="Delete"
                        aria-label="Delete">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>`;
        return card;
    }

    // ---------- View switching ----------

    function showListView() {
        document.getElementById('ss-form-view')?.classList.add('d-none');
        document.getElementById('ss-list-view')?.classList.remove('d-none');
        editingEntry = null;
    }

    function showFormView(entry) {
        editingEntry = entry || null;
        document.getElementById('ss-form-title').textContent =
            entry ? `Edit: ${entry.name}` : 'New Scheduled Search';

        document.getElementById('ss-id').value = entry?.id || '';
        document.getElementById('ss-name').value = entry?.name || '';
        document.getElementById('ss-cron').value = entry?.cron || '';
        document.getElementById('ss-enabled').checked = entry ? !!entry.enabled : true;
        document.getElementById('ss-query').value = entry?.query || '';

        const searchIn = entry?.search_in || { title: true, author: true, series: true };
        document.querySelectorAll('.ss-search-in').forEach(cb => {
            cb.checked = !!searchIn[cb.dataset.field];
        });

        const mainCats = entry?.main_cats || [];
        document.querySelectorAll('.ss-main-cat').forEach(cb => {
            cb.checked = mainCats.includes(cb.value);
        });

        const defaultLang = window.DEFAULT_LANGUAGE_ID != null ? [String(window.DEFAULT_LANGUAGE_ID)] : [];
        const langIds = (entry?.language_ids?.length ? entry.language_ids : defaultLang).map(String);
        setLanguageValues(langIds);

        document.getElementById('ss-min-seeders').value = entry?.min_seeders || '';
        document.getElementById('ss-min-size').value = entry?.min_size || '';
        document.getElementById('ss-max-size').value = entry?.max_size || '';
        document.getElementById('ss-size-unit').value = entry?.size_unit || '1048576';
        document.getElementById('ss-freeleech-only').checked = !!entry?.freeleech_only;

        document.getElementById('ss-auto-grab').checked = entry ? !!entry.auto_grab : true;
        document.getElementById('ss-grab-limit').value = entry ? Number(entry.grab_limit_per_run ?? 5) : 5;
        document.getElementById('ss-use-wedges').checked = !!entry?.use_wedges;

        document.getElementById('ss-torrent-category').value = entry?.torrent_category || '';
        populateDestinationSelect(entry?.destination_path || '');

        document.getElementById('ss-list-view')?.classList.add('d-none');
        document.getElementById('ss-form-view')?.classList.remove('d-none');
        document.getElementById('ss-name')?.focus();
    }

    // ---------- Language select (TomSelect if available, like #langSelect) ----------

    function initLanguageSelect() {
        const el = document.getElementById('ss-language');
        if (!el || typeof TomSelect === 'undefined') return;
        langTomSelect = new TomSelect(el, {
            plugins: ['remove_button', 'checkbox_options'],
            create: false,
            maxItems: null,
            maxOptions: 1000,
            hidePlaceholder: true
        });
    }

    function setLanguageValues(values) {
        if (langTomSelect) {
            langTomSelect.setValue(values, true);
            return;
        }
        const el = document.getElementById('ss-language');
        if (!el) return;
        Array.from(el.options).forEach(opt => { opt.selected = values.includes(opt.value); });
    }

    function getLanguageValues() {
        if (langTomSelect) {
            const value = langTomSelect.getValue();
            return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
        }
        const el = document.getElementById('ss-language');
        return el ? Array.from(el.selectedOptions).map(opt => opt.value) : [];
    }

    // ---------- Destination path (reuses DESTINATION_PATHS like the download confirm modal) ----------

    function populateDestinationSelect(currentPath) {
        const select = document.getElementById('ss-destination-select');
        const custom = document.getElementById('ss-destination-custom');
        if (!select || !custom) return;

        const paths = [...new Set((window.DESTINATION_PATHS || [])
            .map(dest => String(dest?.path || '').trim())
            .filter(Boolean))];

        select.innerHTML = '';
        select.appendChild(new Option('Default organized path', ''));
        paths.forEach(path => select.appendChild(new Option(path, path)));
        select.appendChild(new Option('Custom path...', '__custom__'));

        custom.value = '';
        if (currentPath && paths.includes(currentPath)) {
            select.value = currentPath;
        } else if (currentPath) {
            select.value = '__custom__';
            custom.value = currentPath;
        } else {
            select.value = '';
        }
        custom.classList.toggle('d-none', select.value !== '__custom__');
    }

    function getDestinationPath() {
        const select = document.getElementById('ss-destination-select');
        const custom = document.getElementById('ss-destination-custom');
        if (!select) return '';
        return select.value === '__custom__' ? (custom?.value || '').trim() : select.value;
    }

    // ---------- Save / delete / run ----------

    function collectPayload() {
        const searchIn = {};
        document.querySelectorAll('.ss-search-in').forEach(cb => { searchIn[cb.dataset.field] = cb.checked; });
        SEARCH_IN_FIELDS.forEach(field => { if (!(field in searchIn)) searchIn[field] = false; });

        const payload = {
            name: document.getElementById('ss-name').value.trim(),
            enabled: document.getElementById('ss-enabled').checked,
            cron: document.getElementById('ss-cron').value.trim(),
            query: document.getElementById('ss-query').value.trim(),
            search_type: editingEntry?.search_type || 'all',
            search_in: searchIn,
            language_ids: getLanguageValues(),
            main_cats: Array.from(document.querySelectorAll('.ss-main-cat:checked')).map(cb => cb.value),
            category_ids: editingEntry?.category_ids || [],
            flag_ids: editingEntry?.flag_ids || [],
            flags_mode: editingEntry?.flags_mode || '0',
            min_size: document.getElementById('ss-min-size').value.trim(),
            max_size: document.getElementById('ss-max-size').value.trim(),
            size_unit: document.getElementById('ss-size-unit').value,
            min_seeders: document.getElementById('ss-min-seeders').value.trim(),
            auto_grab: document.getElementById('ss-auto-grab').checked,
            grab_limit_per_run: Math.max(0, parseInt(document.getElementById('ss-grab-limit').value, 10) || 0),
            freeleech_only: document.getElementById('ss-freeleech-only').checked,
            use_wedges: document.getElementById('ss-use-wedges').checked,
            torrent_category: document.getElementById('ss-torrent-category').value.trim(),
            destination_path: getDestinationPath(),
        };
        const id = document.getElementById('ss-id').value.trim();
        if (id) payload.id = id;
        return payload;
    }

    async function saveEntry(payload, { silent = false } = {}) {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to save scheduled search.');
        }
        if (!silent) notify(`Scheduled search "${payload.name || 'Unnamed search'}" saved.`, 'success');
        await loadList();
        return data.scheduled_search;
    }

    async function handleFormSubmit(event) {
        event.preventDefault();
        const payload = collectPayload();

        if (!payload.cron) {
            notify('A cron schedule is required (e.g. "0 6 * * *").', 'danger');
            return;
        }
        if (!payload.query && !payload.main_cats.length && !payload.category_ids.length && !payload.flag_ids.length) {
            notify('The search needs at least a query or a category filter.', 'danger');
            return;
        }

        const saveButton = document.getElementById('ss-save-button');
        const originalHtml = saveButton.innerHTML;
        saveButton.disabled = true;
        saveButton.innerHTML =
            '<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>Saving...';
        try {
            await saveEntry(payload);
            showListView();
        } catch (error) {
            notify(error.message, 'danger');
        } finally {
            saveButton.disabled = false;
            saveButton.innerHTML = originalHtml;
        }
    }

    async function handleToggle(entry, enabled, checkbox) {
        const { state, ...definition } = entry;
        definition.enabled = enabled;
        try {
            await saveEntry(definition, { silent: true });
            notify(`"${entry.name}" ${enabled ? 'enabled' : 'disabled'}.`, 'success');
        } catch (error) {
            checkbox.checked = !enabled;
            notify(error.message, 'danger');
        }
    }

    async function handleDelete(entry) {
        if (!window.confirm(`Delete scheduled search "${entry.name}"? This cannot be undone.`)) return;
        try {
            const response = await fetch(`${API_URL}/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || 'Failed to delete scheduled search.');
            notify(`Scheduled search "${entry.name}" deleted.`, 'success');
            await loadList();
        } catch (error) {
            notify(error.message, 'danger');
        }
    }

    async function handleRunNow(entry, button) {
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML =
            '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Running...';
        try {
            const response = await fetch(`${API_URL}/${encodeURIComponent(entry.id)}/run`, { method: 'POST' });
            const data = await response.json();
            const counts = `found ${data.found ?? 0}, new ${data.new ?? 0}, grabbed ${data.grabbed ?? 0}` +
                (data.skipped ? `, skipped ${data.skipped}` : '');
            if (data.status === 'ok') {
                notify(`"${entry.name}": ${counts}.`, 'success');
            } else if (data.status === 'partial') {
                const firstError = (data.errors || [])[0] || 'some grabs failed';
                notify(`"${entry.name}": ${counts}. ${firstError}`, 'warning');
            } else if (data.status === 'already_running') {
                notify(`"${entry.name}" is already running.`, 'warning');
            } else {
                notify((data.errors || [])[0] || `Failed to run "${entry.name}".`, 'danger');
            }
        } catch (error) {
            notify(error.message || `Failed to run "${entry.name}".`, 'danger');
        } finally {
            button.disabled = false;
            button.innerHTML = originalHtml;
            await loadList();
        }
    }

    // ---------- Wiring ----------

    document.addEventListener('DOMContentLoaded', () => {
        const offcanvasEl = document.getElementById('scheduledSearchesOffcanvas');
        if (!offcanvasEl) return;

        initLanguageSelect();

        // The launcher button toggles the offcanvas via data-bs-toggle, so its
        // tooltip has to be created directly (it can't also carry data-bs-toggle="tooltip").
        const launcherButton = document.getElementById('scheduled-searches-button');
        if (launcherButton && window.bootstrap?.Tooltip) {
            new bootstrap.Tooltip(launcherButton);
        }

        offcanvasEl.addEventListener('show.bs.offcanvas', () => {
            showListView();
            loadList();
        });

        document.getElementById('ss-add-button')?.addEventListener('click', () => showFormView(null));
        document.getElementById('ss-cancel-button')?.addEventListener('click', showListView);
        document.getElementById('scheduled-search-form')?.addEventListener('submit', handleFormSubmit);

        document.querySelectorAll('.ss-cron-preset').forEach(button => {
            button.addEventListener('click', () => {
                document.getElementById('ss-cron').value = button.dataset.cron || '';
            });
        });

        document.getElementById('ss-destination-select')?.addEventListener('change', event => {
            document.getElementById('ss-destination-custom')
                ?.classList.toggle('d-none', event.target.value !== '__custom__');
        });

        // Delegated actions for the (re-rendered) list
        document.getElementById('ss-list')?.addEventListener('click', event => {
            const card = event.target.closest('[data-ss-id]');
            if (!card) return;
            const entry = entriesById[card.dataset.ssId];
            if (!entry) return;

            const runButton = event.target.closest('.ss-run');
            if (runButton) { handleRunNow(entry, runButton); return; }
            if (event.target.closest('.ss-edit')) { showFormView(entry); return; }
            if (event.target.closest('.ss-delete')) { handleDelete(entry); }
        });

        document.getElementById('ss-list')?.addEventListener('change', event => {
            const checkbox = event.target.closest('.ss-toggle');
            if (!checkbox) return;
            const card = event.target.closest('[data-ss-id]');
            const entry = card ? entriesById[card.dataset.ssId] : null;
            if (entry) handleToggle(entry, checkbox.checked, checkbox);
        });
    });
})();
