(() => {
    'use strict';

    // ---------- storage ----------
    const KEYS = { base: 'readerBaseUrl', token: 'readerToken', project: 'readerProjectId', account: 'readerAccount' };
    const CACHE_PREFIX = 'readerCache:';
    // Existing credentials predate explicit consent to persistent storage.
    try {
        if (localStorage.getItem('readerRemember') !== 'yes') {
            Object.keys(localStorage).filter((k) => k.startsWith('reader')).forEach((k) => localStorage.removeItem(k));
        }
    } catch (_) { /* storage unavailable */ }
    let persistent = false;
    try { persistent = !sessionStorage.getItem(KEYS.token) && localStorage.getItem('readerRemember') === 'yes'; } catch (_) { /* session only */ }
    const storage = () => persistent ? localStorage : sessionStorage;
    const store = {
        get(k) { try { return (k === 'sensoriumTheme' ? localStorage : storage()).getItem(k); } catch (_) { return null; } },
        set(k, v) { try { (k === 'sensoriumTheme' ? localStorage : storage()).setItem(k, v); } catch (_) { /* quota/private mode */ } },
        del(k) { try { storage().removeItem(k); } catch (_) { /* ignore */ } },
        clearAll() {
            for (const name of ['localStorage', 'sessionStorage']) {
                try {
                    const target = window[name];
                    Object.keys(target).filter((k) => k.startsWith('reader')).forEach((k) => target.removeItem(k));
                } catch (_) { /* ignore */ }
            }
        },
    };
    let generation = 0;
    const requests = new Set();
    const cancelled = () => new DOMException('Request cancelled', 'AbortError');
    function invalidate() {
        generation++;
        requests.forEach((controller) => controller.abort());
        requests.clear();
    }

    const CONFIG = window.READER_CONFIG || {};
    const PRESETS = Array.isArray(CONFIG.presets) ? CONFIG.presets : [];
    // Same-origin by default when served from the Sensorium server itself.
    const DEFAULT_BASE = location.pathname.startsWith('/reader') ? location.origin : (CONFIG.defaultBase || PRESETS[0] || '');

    const cfg = {
        get base() { return store.get(KEYS.base) || DEFAULT_BASE; },
        get token() { return store.get(KEYS.token); },
        get project() { return store.get(KEYS.project); },
    };

    // ---------- theme ----------
    // Default is light; 'system' follows the OS and 'dark' forces dark. Kept outside the reader* keys so sign out doesn't reset it.
    const THEME_KEY = 'sensoriumTheme';
    function applyTheme(mode) {
        const root = document.documentElement;
        root.dataset.theme = mode;
        const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = dark ? '#2a2a2e' : '#ffffff';
    }
    const savedTheme = () => (['dark', 'system'].includes(store.get(THEME_KEY)) ? store.get(THEME_KEY) : 'light');
    applyTheme(savedTheme());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(savedTheme()));

    // ---------- DOM helpers (no innerHTML: all content is untrusted) ----------
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v == null || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat(Infinity)) {
            if (c == null || c === false) continue;
            el.append(c.nodeType ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    function safeUrl(u) {
        try {
            const url = new URL(u);
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
        } catch (_) { return null; }
    }

    // Minimal markdown: paragraphs, #/## headings, -/* lists, **bold**, *italic*. Builds DOM nodes.
    function inline(text) {
        const out = [];
        const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) out.push(text.slice(last, m.index));
            const s = m[0];
            out.push(s.startsWith('**') ? h('strong', null, s.slice(2, -2)) : h('em', null, s.slice(1, -1)));
            last = m.index + s.length;
        }
        if (last < text.length) out.push(text.slice(last));
        return out;
    }

    function markdown(text) {
        const frag = document.createDocumentFragment();
        let list = null;
        for (const raw of String(text || '').split(/\r?\n/)) {
            const line = raw.trim();
            const li = line.match(/^[-*]\s+(.*)/);
            if (li) {
                if (!list) { list = h('ul'); frag.append(list); }
                list.append(h('li', null, inline(li[1])));
                continue;
            }
            list = null;
            if (!line) continue;
            const hd = line.match(/^#{1,6}\s+(.*)/);
            frag.append(hd ? h('p', null, h('strong', null, hd[1])) : h('p', null, inline(line)));
        }
        return frag;
    }

    // ---------- newsletter display ----------
    // Mirrors the Collation Newsletter View's default display profile (field keys match the web app).
    const DISPLAY = {
        'newsletter-title': true,
        'images': true,
        'summary-analysis': true,
        'summary-title': true,
        'summary-content-plain-first': true,
        'summary-content-plain-remaining': false,
        'summary-narrative': false,
        'why-important': false,
        'original-article': false,
        'story-links': false,
        'commentary': true,
    };

    // Plain text with paragraph/line breaks and *emphasis* -> nodes.
    function emphasised(text) {
        const out = [];
        String(text || '').trim().replace(/\r\n/g, '\n').split(/\n{2,}/).forEach((para, i) => {
            if (i) out.push(h('br'), h('br'));
            para.split('\n').forEach((line, j) => { if (j) out.push(h('br')); out.push(inline(line)); });
        });
        return out;
    }

    // Same rule as the web newsletter: split after the 2nd sentence ending.
    function splitSentences(text) {
        const t = String(text || '').trim();
        const ends = [];
        let m;
        const strict = /[.!?]+\s+(?=[A-Z])/g;
        while ((m = strict.exec(t)) && ends.length < 2) ends.push(m.index + m[0].length);
        if (ends.length < 2) {
            const loose = /[.!?]+\s+/g;
            const all = [];
            while ((m = loose.exec(t))) all.push(m.index + m[0].length);
            for (const e of all.slice(0, 2)) if (ends.length < 2 && !ends.includes(e)) ends.push(e);
        }
        if (!ends.length) return { first: t, rest: '' };
        const at = ends[Math.min(ends.length, 2) - 1];
        return { first: t.slice(0, at).trim(), rest: t.slice(at).trim() };
    }

    function serverUrl(value) {
        const url = new URL(value);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) {
            throw new Error('Use an HTTPS server URL (HTTP is allowed only for localhost). Do not include credentials, a query, or a fragment.');
        }
        return url.href.replace(/\/+$/, '');
    }

    // ---------- API ----------
    class AuthError extends Error {}

    async function api(path, { base = cfg.base, token = cfg.token } = {}) {
        base = serverUrl(base);
        const mine = generation;
        const controller = new AbortController();
        requests.add(controller);
        try {
            let res;
            try {
                res = await fetch(`${base}/api/v1${path}`, {
                    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                    cache: 'no-store', credentials: 'omit', signal: controller.signal,
                });
            } catch (e) {
                if (mine !== generation || e.name === 'AbortError') throw cancelled();
                throw new Error('Cannot reach the server (offline, or the server blocks this origin).');
            }
            const body = await res.json().catch(() => ({}));
            if (mine !== generation) throw cancelled();
            if (res.status === 401 || res.status === 403) {
                throw new AuthError(body.message || 'Token rejected. Check the API key and its scopes.');
            }
            if (!res.ok) throw new Error((body.error && body.error.message) || body.message || `Request failed (${res.status})`);
            return body;
        } finally { requests.delete(controller); }
    }

    // A random namespace belongs to this credential session, never to a raw token.
    async function cachedApi(path) {
        const mine = generation;
        const key = `${CACHE_PREFIX}${store.get(KEYS.account)}:${cfg.base}${path}`;
        try {
            const data = await api(path);
            if (mine !== generation) throw cancelled();
            store.set(key, JSON.stringify(data));
            return { data, stale: false };
        } catch (e) {
            if (mine !== generation || e.name === 'AbortError') throw cancelled();
            if (e instanceof AuthError) throw e;
            const hit = store.get(key);
            if (hit) return { data: JSON.parse(hit), stale: true };
            throw e;
        }
    }

    // ---------- chrome ----------
    const $ = (id) => document.getElementById(id);
    const view = $('view');
    const show = (...nodes) => view.replaceChildren(...nodes.flat(Infinity).filter(Boolean));

    function chrome({ title, back }) {
        clearToc();
        $('topbar').hidden = false;
        $('topTitle').textContent = title;
        $('backBtn').hidden = !back;
        $('backBtn').onclick = back ? () => { location.hash = back; } : null;
        document.documentElement.style.setProperty('--topbar-h', `${$('topbar').offsetHeight}px`);
        document.title = title === 'Sensorium Reader' ? title : `${title} · Sensorium Reader`;
        loadProjectPicker();
    }

    // "Ben's Default Project" -> "BDP"; single-word names are kept as is.
    function abbreviate(name) {
        const words = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return words[0] || '?';
        return words.map((w) => Array.from(w)[0].toUpperCase()).join('');
    }
    // Prefer the key user's "Default" project when none (or an unknown one) is selected.
    function pickDefaultProject(projects) {
        return projects.find((p) => p.is_default === true)
            || projects.find((p) => /\bdefault\b/i.test(p.name || ''))
            || projects[0];
    }
    async function loadProjectPicker() {
        const gen = generation;
        try {
            const { data: body } = await cachedApi('/projects');
            const data = body.data;
            if (gen !== generation || !Array.isArray(data) || !data.length) return;
            let current = data.find((p) => String(p.id) === cfg.project);
            if (!current) {
                current = pickDefaultProject(data);
                store.set(KEYS.project, String(current.id));
            }
            $('projectText').textContent = abbreviate(current.name);
            $('projectBtn').title = current.name;
            $('projectMenu').replaceChildren(...data.map((p) => h('button', {
                type: 'button', class: 'project-item', role: 'option', title: p.name,
                'aria-selected': String(p.id) === String(current.id) ? 'true' : 'false',
                onclick: () => {
                    closeProjectMenu();
                    if (String(p.id) === cfg.project) return;
                    store.set(KEYS.project, String(p.id));
                    location.hash = '#/';
                    route();
                },
            }, p.name)));
            $('projectWrap').hidden = false;
            document.documentElement.style.setProperty('--topbar-h', `${$('topbar').offsetHeight}px`);
        } catch (e) { $('projectWrap').hidden = true; }
    }
    function closeProjectMenu() {
        $('projectMenu').hidden = true;
        $('projectBtn').setAttribute('aria-expanded', 'false');
    }
    $('projectBtn').addEventListener('click', () => {
        const open = $('projectMenu').hidden;
        $('projectMenu').hidden = !open;
        $('projectBtn').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#projectWrap')) closeProjectMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProjectMenu(); });

    function note(msg, cls) { return h('p', { class: cls || 'muted' }, msg); }

    // ---------- sheets ----------
    // 'main' is the right-hand panel. 'child' opens to its right (desktop) or on top of it (mobile).
    const SHEETS = {
        main: { el: 'sheet', title: 'sheetTitle', body: 'sheetBody', close: 'sheetClose' },
        child: { el: 'sheet2', title: 'sheet2Title', body: 'sheet2Body', close: 'sheet2Close' },
    };

    // Key of the story/link shown in the main panel (null when closed or showing something else).
    let activeKey = null;

    function syncBackdrop() {
        const open = !$('sheet').hidden;
        const child = open && !$('sheet2').hidden;
        $('sheetBackdrop').hidden = !open;
        $('sheet').classList.toggle('has-child', child);
        document.body.classList.toggle('sheet-open', open);
        document.body.classList.toggle('sheet-child-open', child);
        document.querySelectorAll('.card[data-key]').forEach((c) => c.classList.toggle('active', open && c.dataset.key === activeKey));
        layoutToc();
    }

    // Clicking the item already shown closes the panel; any other item replaces the content.
    function toggledOff(key) {
        if (!$('sheet').hidden && activeKey === key) { closeSheet(); return true; }
        activeKey = key;
        $('sheet2').hidden = true;
        return false;
    }

    function openSheet(title, bodyNodes, level = 'main') {
        const ids = SHEETS[level];
        $(ids.title).textContent = title;
        const body = $(ids.body);
        body.replaceChildren(...bodyNodes.flat(Infinity).filter(Boolean));
        body.scrollTop = 0;
        $(ids.el).hidden = false;
        syncBackdrop();
        $(ids.close).focus();
    }
    function setSheetBody(bodyNodes, level = 'main') {
        $(SHEETS[level].body).replaceChildren(...bodyNodes.flat(Infinity).filter(Boolean));
    }
    function closeSheet(level) {
        if (level !== 'child') { $('sheet').hidden = true; activeKey = null; }
        $('sheet2').hidden = true;
        syncBackdrop();
    }
    $('sheetClose').addEventListener('click', () => closeSheet());
    $('sheet2Close').addEventListener('click', () => closeSheet('child'));
    $('sheetBackdrop').addEventListener('click', () => closeSheet());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeSheet($('sheet2').hidden ? undefined : 'child');
    });

    function labelled(label, text) {
        return text ? [h('h3', null, label), markdown(text)] : [];
    }

    const sensoriumUrl = (kind, id) => `${cfg.base.replace(/\/+$/, '')}/projects/${cfg.project}/${kind}/${id}`;
    const categoryUrl = (cat) => `${cfg.base.replace(/\/+$/, '')}/projects/${cfg.project}/links?tag=${encodeURIComponent(cat)}`;

    function externalBtn(href, label, secondary) {
        const safe = safeUrl(href);
        return safe ? h('a', { class: secondary ? 'btn secondary' : 'btn', href: safe, target: '_blank', rel: 'noopener noreferrer' }, label) : null;
    }

    function sensoriumBtn(href) {
        const safe = safeUrl(href);
        const label = 'View in Sensorium';
        return safe ? h('a', { class: 'btn icon-square', href: safe, target: '_blank', rel: 'noopener noreferrer', title: label, 'aria-label': label },
            h('img', { src: 'icons/s7m-icon-32x32.png', width: 24, height: 24, alt: '' }),
            h('span', { class: 'ext-arrow', 'aria-hidden': 'true' }, '↗')) : null;
    }

    // Citation with a copy button. Copies rich text (italics kept) with a plain-text fallback.
    function citationBlock(text) {
        const body = h('span', null, emphasised(text));
        const btn = h('button', { class: 'copy-btn', type: 'button', title: 'Copy citation to clipboard', 'aria-label': 'Copy citation to clipboard' }, '📋');
        btn.addEventListener('click', async () => {
            const plain = body.textContent;
            let ok = false;
            try {
                if (window.ClipboardItem && navigator.clipboard.write) {
                    await navigator.clipboard.write([new ClipboardItem({
                        'text/html': new Blob([body.innerHTML], { type: 'text/html' }),
                        'text/plain': new Blob([plain], { type: 'text/plain' }),
                    })]);
                } else {
                    await navigator.clipboard.writeText(plain);
                }
                ok = true;
            } catch (_) {
                try { await navigator.clipboard.writeText(plain); ok = true; } catch (__) { /* clipboard blocked */ }
            }
            btn.textContent = ok ? '✓' : '✗';
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
        });
        return h('div', { class: 'citation' }, body, btn);
    }

    function linkBody(d, loaded) {
        return [
            d.publisher_name ? note(d.publisher_name) : null,
            d.summary_title ? h('p', null, h('strong', null, d.summary_title)) : null,
            d.summary ? h('p', null, emphasised(d.summary)) : null,
            h('div', { class: 'src-row' },
                safeUrl(d.url) ? h('p', null, h('strong', null, 'Source '),
                    h('a', { class: 'src-link', href: safeUrl(d.url), target: '_blank', rel: 'noopener noreferrer' }, d.source_title || d.title || d.url)) : h('span'),
                sensoriumBtn(sensoriumUrl('links', d.id))),
            d.citation ? citationBlock(d.citation) : null,
            labelled('Signals', d.why_important),
            d.narrative ? [h('h3', null, 'AI-generated narrative'), h('p', null, h('em', null, d.narrative))] : null,
            labelled('Editorial commentary', d.commentary),
            loaded === 'error' ? null
                : !loaded ? [h('h3', null, 'Categories'), note('Loading…')]
                : (d.categories || []).length ? [h('h3', null, 'Categories'),
                    h('div', { class: 'chips' }, d.categories.map((c) => externalBtn(categoryUrl(c), c, true)))] : null,
        ];
    }

    // Shows what the caller already has immediately, then fills in citation, categories and
    // (for story sources, which arrive without one) the summary from the server.
    const linkLoad = { main: 0, child: 0 };

    async function showLink(item, level = 'main') {
        if (level === 'main' && toggledOff(`link:${item.id}`)) return;
        const mine = ++linkLoad[level];
        openSheet(item.title || item.url || 'Link', linkBody(item, false), level);
        try {
            const { data } = await cachedApi(`/projects/${cfg.project}/links/${item.id}/reader`);
            if (mine !== linkLoad[level]) return; // a newer selection replaced this one
            const d = { ...item, ...data.data, commentary: item.commentary };
            $(SHEETS[level].title).textContent = d.title || d.url || 'Link';
            setSheetBody(linkBody(d, true), level);
        } catch (e) {
            if (e.name === 'AbortError' || mine !== linkLoad[level]) return;
            setSheetBody([linkBody(item, 'error'), note(e.message, 'error')], level);
        }
    }

    function showStory(story) {
        if (toggledOff(`story:${story.id}`)) return;
        linkLoad.main++;
        openSheet(story.title || 'Story', [
            story.summary ? h('p', null, emphasised(story.summary)) : null,
            labelled('Editorial commentary', story.commentary),
            h('div', { class: 'src-row' }, h('h3', null, `Sources (${story.links.length})`), sensoriumBtn(sensoriumUrl('stories', story.id))),
            story.links.map((l) => h('button', { class: 'link-row', onclick: () => showLink(l, 'child') },
                h('div', { class: 'title' }, l.title || l.url),
                l.publisher_name ? h('div', { class: 'meta muted' }, l.publisher_name) : null)),
        ]);
    }

    // ---------- contents navigator ----------
    // Fixed in the left margin; the newsletter and panels start to its right.
    const tocHeads = []; // { el: heading element, btn: its contents button }
    let tocActive = false; // a newsletter is showing, so the sidebar (search + contents) is wanted
    let searchState = null; // set by renderToc: { input, status, index: [{ el, hay }] }

    function clearToc() {
        tocHeads.length = 0;
        tocActive = false;
        searchState = null;
        const toc = $('toc');
        toc.replaceChildren();
        toc.hidden = true;
        document.body.classList.remove('toc-on');
    }

    function renderToc(sections) {
        clearToc();
        const heads = [...view.querySelectorAll('h2.section, h3.subsection')];
        let i = 0;
        const entry = (name, cls) => {
            const el = heads[i++];
            const btn = h('button', { class: cls, type: 'button', onclick: () => el.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, name);
            tocHeads.push({ el, btn });
            return btn;
        };
        const list = h('ul');
        for (const sec of sections) {
            const subs = sec.subsections.filter((sub) => sub.name);
            if (sec.name) {
                list.append(h('li', null, entry(sec.name, 'toc-sec'),
                    subs.length ? h('ul', null, subs.map((sub) => h('li', null, entry(sub.name, 'toc-sub')))) : null));
            } else {
                subs.forEach((sub) => list.append(h('li', null, entry(sub.name, 'toc-sec'))));
            }
        }
        const input = h('input', { type: 'search', class: 'toc-search', placeholder: 'Search newsletter', 'aria-label': 'Search newsletter', autocomplete: 'off', spellcheck: 'false' });
        const status = h('p', { class: 'toc-status', 'aria-live': 'polite' });
        const index = buildSearchIndex(sections);
        searchState = { input, status, index };
        let timer = 0;
        input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 120); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { input.value = ''; runSearch(); e.stopPropagation(); } });
        tocActive = index.length > 0;
        $('toc').replaceChildren(...[input, status, ...(tocHeads.length > 1 ? [h('h2', null, 'Contents'), list] : [])]);
        layoutToc();
        markCurrentToc();
    }

    // ---------- search ----------
    const fold = (t) => String(t || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

    // One lower-cased haystack per newsletter item, covering everything the item carries
    // (not just what its card shows), keyed to the card element.
    function buildSearchIndex(sections) {
        const cards = new Map([...view.querySelectorAll('article.card[data-key]')].map((c) => [c.dataset.key, c]));
        const index = [];
        for (const sec of sections) {
            for (const sub of sec.subsections) {
                for (const it of sub.items) {
                    const el = cards.get(`${it.type}:${it.id}`);
                    if (!el) continue;
                    const parts = [it.title, it.summary_title, it.summary, it.narrative, it.why_important, it.commentary,
                        it.source_title, it.publisher_name, ...(it.links || []).flatMap((l) => [l.title, l.publisher_name])];
                    index.push({ el, hay: fold(parts.filter(Boolean).join('\n')) });
                }
            }
        }
        return index;
    }

    function clearHighlights(root) {
        root.querySelectorAll('mark.hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
        root.normalize();
    }

    function highlight(root, terms) {
        const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
            const text = node.nodeValue;
            const folded = fold(text);
            const src = folded.length === text.length ? folded : text; // fold only when it keeps offsets aligned
            re.lastIndex = 0;
            let last = 0, m, frag = null;
            while ((m = re.exec(src))) {
                if (!m[0]) { re.lastIndex++; continue; }
                frag = frag || document.createDocumentFragment();
                frag.append(text.slice(last, m.index), h('mark', { class: 'hit' }, text.slice(m.index, m.index + m[0].length)));
                last = m.index + m[0].length;
            }
            if (frag) { frag.append(text.slice(last)); node.replaceWith(frag); }
        }
    }

    // Filters the newsletter to items containing every typed word, hides headings left empty,
    // trims the contents list to match, and highlights hits.
    function runSearch() {
        if (!searchState) return;
        const { input, status, index } = searchState;
        const terms = fold(input.value).split(/\s+/).filter(Boolean);
        const filtering = terms.length > 0;

        let shown = 0;
        for (const { el, hay } of index) {
            clearHighlights(el);
            const hit = !filtering || terms.every((t) => hay.includes(t));
            el.hidden = !hit;
            if (hit) { shown++; if (filtering) highlight(el, terms); }
        }

        // A heading is shown when any card before the next heading of its level is shown.
        const nodes = [...view.children];
        const counts = new Map();
        let sec = null, sub = null;
        for (const n of nodes) {
            if (n.matches('h2.section')) { sec = n; sub = null; counts.set(n, 0); }
            else if (n.matches('h3.subsection')) { sub = n; counts.set(n, 0); }
            else if (n.matches('article.card') && !n.hidden) {
                if (sec) counts.set(sec, counts.get(sec) + 1);
                if (sub) counts.set(sub, counts.get(sub) + 1);
            }
        }
        counts.forEach((count, el) => { el.hidden = filtering && count === 0; });
        tocHeads.forEach(({ el, btn }) => { btn.closest('li').hidden = el.hidden; });

        const empty = view.querySelector('.search-empty');
        if (empty) empty.remove();
        if (filtering && !shown) view.append(h('p', { class: 'muted search-empty' }, `No matches for “${input.value.trim()}”.`));
        status.textContent = filtering ? `${shown} of ${index.length} items` : '';
        markCurrentToc();
    }

    // "/" jumps to the search box (unless already typing somewhere).
    document.addEventListener('keydown', (e) => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || !searchState || $('toc').hidden) return;
        e.preventDefault();
        searchState.input.focus();
    });

    // The navigator is shown only when the newsletter still gets at least NEWS_MIN px beside it
    // (and beside any open panels); body.toc-on moves the newsletter right to make room.
    const TOC_COLUMN = 280, NEWS_MIN = 420, PANEL_W = 460;

    function layoutToc() {
        const toc = $('toc');
        const panels = $('sheet').hidden ? 0 : ($('sheet2').hidden || innerWidth < 1300 ? 1 : 2);
        const fits = innerWidth >= 900 && TOC_COLUMN + NEWS_MIN + panels * PANEL_W <= innerWidth;
        const on = tocActive && fits;
        toc.hidden = !on;
        document.body.classList.toggle('toc-on', on);
    }

    function markCurrentToc() {
        const visible = tocHeads.filter((hd) => !hd.el.hidden);
        if (!visible.length) return;
        const line = $('topbar').offsetHeight + 40;
        let current = visible[0];
        for (const hd of visible) { if (hd.el.getBoundingClientRect().top <= line) current = hd; }
        tocHeads.forEach((hd) => hd.btn.classList.toggle('current', hd === current));
    }

    let tocFrame = 0;
    const scheduleToc = () => { cancelAnimationFrame(tocFrame); tocFrame = requestAnimationFrame(() => { layoutToc(); markCurrentToc(); }); };
    window.addEventListener('scroll', scheduleToc, { passive: true });
    window.addEventListener('resize', scheduleToc);

    // ---------- views ----------
    function viewSetup(message) {
        chrome({ title: 'Sensorium Reader' });
        $('menuBtn').hidden = true;
        const sel = h('select', { id: 'baseSel' },
            PRESETS.map((p) => h('option', { value: p }, p)), h('option', { value: 'custom' }, 'Custom…'));
        const custom = h('input', { id: 'baseCustom', type: 'url', placeholder: 'https://…', hidden: true });
        const token = h('input', { id: 'token', type: 'password', autocomplete: 'off', required: true, placeholder: 'Paste API key' });
        const remember = h('input', { type: 'checkbox' });
        const err = h('p', { class: 'error' }, message || '');
        const btn = h('button', { class: 'btn', type: 'submit' }, 'Connect');

        const current = cfg.base;
        if (PRESETS.includes(current)) sel.value = current;
        else if (location.pathname.startsWith('/reader') && current === location.origin) {
            sel.prepend(h('option', { value: current }, `${current} (this server)`));
            sel.value = current;
        } else { sel.value = 'custom'; custom.hidden = false; custom.value = current; }
        sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; });

        const form = h('form', { class: 'setup' },
            h('label', null, 'Server', sel, custom),
            h('label', null, 'API key', token),
            h('label', { class: 'remember' }, remember, 'Remember this device (stores API key and newsletters on disk)'),
            err, btn);
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            let base;
            try { base = serverUrl((sel.value === 'custom' ? custom.value : sel.value).trim()); }
            catch (ex) { err.textContent = ex.message; return; }
            invalidate();
            btn.disabled = true; err.textContent = '';
            try {
                const { data } = await api('/projects', { base, token: token.value.trim() });
                if (!data.length) throw new Error('This key has no accessible projects.');
                invalidate();
                store.clearAll();
                persistent = remember.checked;
                if (persistent) store.set('readerRemember', 'yes');
                store.set(KEYS.account, crypto.randomUUID());
                store.set(KEYS.base, base);
                store.set(KEYS.token, token.value.trim());
                const keep = data.find((p) => String(p.id) === cfg.project);
                store.set(KEYS.project, String((keep || pickDefaultProject(data)).id));
                location.hash = '#/';
                route();
            } catch (ex) {
                if (ex.name === 'AbortError') return;
                err.textContent = ex.message;
                btn.disabled = false;
            }
        });
        show(
            h('h2', null, 'Sign in'),
            note('Create an API key in Sensorium (API Tokens). A read-only key with collations, links, stories, sections and analysis scopes is enough.'),
            form);
    }

    async function viewList() {
        chrome({ title: 'Newsletters' });
        $('menuBtn').hidden = false;
        show(note('Loading…'));
        try {
            const { data, stale } = await cachedApi(`/projects/${cfg.project}/collations?per_page=50`);
            const rows = data.data || [];
            show(
                stale ? note('Offline — showing saved copy.') : null,
                rows.length ? rows.map((c) => h('a', { class: 'card', href: `#/c/${c.id}` },
                    h('div', { class: 'title' }, c.published_title || c.name,
                        c.publish_status !== 'published' ? h('span', { class: 'badge' }, c.publish_status) : null),
                    c.published_subtitle ? h('div', { class: 'summary' }, c.published_subtitle) : null,
                    c.publish_date_time ? h('div', { class: 'meta' }, new Date(c.publish_date_time).toLocaleDateString()) : null))
                    : note('No collations yet.'));
        } catch (e) { fail(e); }
    }

    async function viewCollation(id) {
        chrome({ title: 'Newsletter', back: '#/' });
        show(note('Loading…'));
        try {
            const { data, stale } = await cachedApi(`/projects/${cfg.project}/collations/${id}/content`);
            const { collation, sections } = data.data;
            chrome({ title: collation.published_title || collation.name, back: '#/' });
            show(
                h('div', { class: 'hero' },
                    h('h2', null, collation.published_title || collation.name),
                    heroSubtitle(collation, sections),
                    stale ? note('Offline — showing saved copy.') : null),
                sections.length ? sections.map(renderSection) : note('This newsletter is empty.'));
            renderToc(sections);
        } catch (e) { fail(e); }
    }

    // Published subtitle, with links to the published (Substack) post and to copy the newsletter as markdown.
    function heroSubtitle(collation, sections) {
        const url = safeUrl(collation.published_url);
        const copy = h('button', { class: 'copy-md', type: 'button', title: 'Copy whole newsletter as markdown' }, '📋 Copy as markdown');
        copy.addEventListener('click', () => copyText(newsletterMarkdown(collation, sections), copy, '📋 Copy as markdown'));
        const parts = [
            collation.published_subtitle,
            url ? h('a', { class: 'src-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'View on Substack ↗') : null,
            copy,
        ].filter(Boolean);
        return h('p', { class: 'muted' }, parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
    }

    async function copyText(text, btn, idleLabel) {
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
            try { // older browsers / non-secure pages
                const ta = h('textarea', { 'aria-hidden': 'true' });
                ta.value = text;
                document.body.append(ta);
                ta.select();
                ok = document.execCommand('copy');
                ta.remove();
            } catch (__) { /* clipboard blocked */ }
        }
        btn.textContent = ok ? '✓ Copied' : '✗ Copy failed';
        setTimeout(() => { btn.textContent = idleLabel; }, 1800);
    }

    // ---------- markdown export ----------
    const mdText = (t) => String(t || '').replace(/\r\n/g, '\n').trim();
    const mdLabel = (t) => String(t || '').replace(/[\[\]]/g, '\\$&').replace(/\s+/g, ' ').trim();
    const mdUrl = (u) => String(u).replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    const mdLink = (label, url) => { const u = safeUrl(url); return u ? `[${mdLabel(label || u)}](${mdUrl(u)})` : mdLabel(label || ''); };

    // The newsletter as displayed (title, image, summary, commentary), plus source links.
    function newsletterMarkdown(collation, sections) {
        const out = [`# ${mdLabel(collation.published_title || collation.name)}`];
        if (collation.published_subtitle) out.push(`_${mdText(collation.published_subtitle)}_`);
        if (safeUrl(collation.published_url)) out.push(mdLink('View on Substack', collation.published_url));

        const item = (it) => {
            const lines = [];
            const isStory = it.type === 'story';
            if (DISPLAY['newsletter-title']) lines.push(`**${mdLabel(it.title || '(untitled)')}**`);
            const img = DISPLAY.images ? safeUrl(it.image_url) : null;
            if (img) lines.push(`![](${mdUrl(img)})`);
            if (DISPLAY['summary-analysis']) {
                if (isStory) {
                    if (DISPLAY['summary-content-plain-first'] && it.summary) lines.push(mdText(it.summary));
                } else {
                    const { first, rest } = splitSentences(it.summary);
                    if (DISPLAY['summary-title'] && it.summary_title) lines.push(`**${mdLabel(it.summary_title)}**`);
                    const text = [DISPLAY['summary-content-plain-first'] && first, DISPLAY['summary-content-plain-remaining'] && rest].filter(Boolean).join(' ');
                    if (text) lines.push(text);
                    if (DISPLAY['summary-narrative'] && it.narrative) lines.push(`_${mdText(it.narrative)}_`);
                    if (DISPLAY['why-important'] && it.why_important) lines.push(mdText(it.why_important));
                }
            }
            // Source links are always included in the export, whatever the cards show.
            if (isStory) {
                const links = (it.links || []).filter((l) => safeUrl(l.url));
                if (links.length) lines.push(`**Sources**\n\n${links.map((l) => `- ${mdLink(l.title, l.url)}`).join('\n')}`);
            } else if (safeUrl(it.url)) {
                lines.push(`**Source** ${mdLink(it.source_title || it.title, it.url)}`);
            }
            if (DISPLAY.commentary && it.commentary) lines.push(`> **Editorial Commentary:** ${mdText(it.commentary).replace(/\n+/g, ' ')}`);
            return lines.join('\n\n');
        };

        for (const sec of sections) {
            if (sec.name) out.push(`## ${mdLabel(sec.name)}`);
            for (const sub of sec.subsections) {
                if (sub.name) out.push(`### ${mdLabel(sub.name)}`);
                sub.items.forEach((it) => out.push(item(it)));
            }
        }
        return `${out.join('\n\n')}\n`;
    }

    function renderSection(sec) {
        return [
            sec.name ? h('h2', { class: 'section' }, sec.name) : null,
            sec.subsections.map((sub) => [
                sub.name ? h('h3', { class: 'subsection' }, sub.name) : null,
                sub.items.map(renderCard),
            ]),
        ];
    }

    function renderCard(item) {
        const img = DISPLAY.images ? safeUrl(item.image_url) : null;
        const isStory = item.type === 'story';
        const open = () => (isStory ? showStory(item) : showLink(item));

        let body = [];
        if (DISPLAY['summary-analysis']) {
            if (isStory) {
                if (DISPLAY['summary-content-plain-first'] && item.summary) body.push(h('div', { class: 'summary' }, emphasised(item.summary)));
            } else {
                const { first, rest } = splitSentences(item.summary);
                if (DISPLAY['summary-title'] && item.summary_title) body.push(h('div', { class: 'summary-title' }, item.summary_title));
                const text = [DISPLAY['summary-content-plain-first'] && first, DISPLAY['summary-content-plain-remaining'] && rest].filter(Boolean).join(' ');
                if (text) body.push(h('div', { class: 'summary' }, emphasised(text)));
                if (DISPLAY['summary-narrative'] && item.narrative) body.push(h('div', { class: 'summary' }, h('em', null, item.narrative)));
                if (DISPLAY['why-important'] && item.why_important) body.push(h('div', { class: 'summary' }, markdown(item.why_important)));
            }
        }

        const srcUrl = safeUrl(item.url);
        const links = [];
        if (!isStory && DISPLAY['original-article'] && srcUrl) {
            links.push(h('strong', null, 'Source '), h('a', { href: srcUrl, target: '_blank', rel: 'noopener noreferrer' }, item.source_title || item.url));
        }

        return h('article', { class: 'card', tabindex: '0', 'data-key': `${item.type}:${item.id}`, onclick: (e) => { if (!e.target.closest('a, button')) open(); },
                onkeydown: (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); } },
            DISPLAY['newsletter-title'] ? h('div', { class: 'title' }, item.title || '(untitled)') : null,
            img ? h('img', { class: 'thumb', src: img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
            body,
            isStory && DISPLAY['story-links'] && item.links.length ? h('div', { class: 'story-sources' },
                h('strong', null, 'Sources'),
                h('ul', null, item.links.map((l) => {
                    const u = safeUrl(l.url);
                    return h('li', null, u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, l.title || l.url) : (l.title || l.url));
                }))) : null,
            links.length ? h('div', { class: 'src-line' }, links) : null,
            DISPLAY.commentary && item.commentary ? h('div', { class: 'commentary' }, h('strong', null, 'Editorial Commentary: '), item.commentary) : null);
    }

    function fail(e) {
        if (e.name === 'AbortError') return;
        if (e instanceof AuthError) { signOut(); viewSetup(e.message); return; }
        show(note(e.message, 'error'),
            h('button', { class: 'btn secondary', onclick: route }, 'Retry'));
    }

    // ---------- settings menu ----------
    async function viewSettings() {
        closeSheet();
        const theme = h('select', null,
            [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([v, l]) => h('option', { value: v }, l)));
        theme.value = savedTheme();
        theme.addEventListener('change', () => {
            store.set(THEME_KEY, theme.value);
            applyTheme(theme.value);
        });
        const body = [
            note(`Server: ${cfg.base}`),
            h('label', null, 'Theme', theme),
            h('div', { class: 'actions' },
                h('button', { class: 'btn secondary', onclick: () => { clearCaches(); closeSheet(); route(); } }, 'Clear saved newsletters'),
                h('button', { class: 'btn', onclick: signOut }, 'Sign out')),
        ];
        openSheet('Settings', body);
    }

    function clearCaches() {
        try { Object.keys(storage()).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => storage().removeItem(k)); } catch (_) { /* ignore */ }
    }
    function signOut() {
        invalidate();
        store.clearAll();
        $('sheetBody').replaceChildren();
        $('sheet2Body').replaceChildren();
        closeSheet();
        location.hash = '#/';
        route();
    }
    $('menuBtn').addEventListener('click', viewSettings);

    // ---------- router ----------
    function route() {
        invalidate();
        closeSheet();
        if (!cfg.token || !cfg.project) { viewSetup(); return; }
        const m = location.hash.match(/^#\/c\/(\d+)$/);
        if (m) viewCollation(m[1]); else viewList();
    }
    window.addEventListener('storage', (event) => {
        if (persistent && event.key && event.key.startsWith('reader')) route();
    });
    window.addEventListener('hashchange', route);
    route();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(() => { /* optional */ });
    }
})();
