const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app.js', 'utf8');
function memory() {
    const values = {};
    return new Proxy({
        getItem: k => values[k] ?? null,
        setItem: (k, v) => { values[k] = String(v); },
        removeItem: k => { delete values[k]; },
    }, { ownKeys: () => Object.keys(values), getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }) });
}
const localStorage = memory(), sessionStorage = memory();
localStorage.setItem('readerToken', 'legacy');
const context = vm.createContext({ localStorage, sessionStorage, URL, DOMException, AbortController,
    location: { pathname: '/', origin: 'https://reader.example' },
    window: { localStorage, sessionStorage }, fetch: null });
const storageCode = source.slice(source.indexOf('    const KEYS'), source.indexOf('    // ---------- theme'));
const urlCode = source.slice(source.indexOf('    function serverUrl'), source.indexOf('    // ---------- chrome'));
vm.runInContext(storageCode + urlCode, context);
const run = code => vm.runInContext(code, context);
assert.equal(localStorage.getItem('readerToken'), null);
for (const url of ['http://example.com', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com/?x=1']) {
    assert.throws(() => run(`serverUrl(${JSON.stringify(url)})`));
}
for (const url of ['https://example.com', 'http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    assert.ok(run(`serverUrl(${JSON.stringify(url)})`));
}
(async () => {
    run("store.set(KEYS.base, 'https://api.example'); store.set(KEYS.token, 'one'); store.set(KEYS.account, 'account-one');");
    assert.equal(localStorage.getItem('readerToken'), null);
    assert.equal(sessionStorage.getItem('readerToken'), 'one');
    let resolveFetch;
    context.fetch = (_url, options) => {
        assert.equal(options.credentials, 'omit');
        return new Promise(resolve => { resolveFetch = resolve; });
    };
    const pending = run("cachedApi('/projects')");
    run('invalidate(); store.clearAll();');
    resolveFetch({ ok: true, status: 200, json: async () => ({ secret: true }) });
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(Object.keys(sessionStorage).length, 0);
    run("store.set(KEYS.base, 'https://api.example'); store.set(KEYS.account, 'account-one');");
    context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ secret: true }) });
    await run("cachedApi('/projects')");
    run("store.set(KEYS.account, 'account-two')");
    context.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(run("cachedApi('/projects')"), /Cannot reach/);
    run("persistent = true; store.set('readerRemember', 'yes'); store.set(KEYS.token, 'remembered');");
    assert.equal(localStorage.getItem('readerToken'), 'remembered');
    run('store.clearAll()');
    assert.equal(Object.keys(localStorage).length, 0);
    assert.equal(Object.keys(sessionStorage).length, 0);
    console.log('Security regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
