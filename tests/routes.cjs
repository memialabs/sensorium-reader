const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
const calls = [];
const context = vm.createContext({
    cfg: { token: 'token', project: '7' },
    location: { hash: '#/l/42' },
    generation: 0, linksBackground: null,
    linksContext: () => 'account',
    invalidate() { context.generation++; }, closeSheet() {},
    showLink: item => calls.push(['link', item.id]),
    viewSetup: () => calls.push('setup'),
    viewLink: id => calls.push(['link', id]),
    viewCollation: id => calls.push(['collation', id]),
    viewList: () => calls.push('newsletters'),
    viewLinks: page => calls.push(['links', page]),
});
vm.runInContext(source.slice(source.indexOf('    async function route(event)'), source.indexOf("    window.addEventListener('storage'")), context);
(async () => {
    // A fresh direct URL loads the list and opens the existing detail panel.
    await context.route();
    assert.deepEqual(calls.splice(0), [['links', 1], ['link', '42']]);
    context.location.hash = '#/';
    await context.route({ type: 'hashchange' });
    assert.deepEqual(calls.splice(0), []);

    context.location.hash = '#/links/3';
    await context.route();
    assert.deepEqual(calls.splice(0), [['links', 3]]);
    context.location.hash = '#/l/99';
    await context.route({ type: 'hashchange' });
    assert.deepEqual(calls.splice(0), [['link', '99']]);
    context.location.hash = '#/links/3';
    await context.route({ type: 'hashchange' });
    assert.deepEqual(calls.splice(0), []); // The mounted list and scroll position survive Back.
    await context.route();
    assert.deepEqual(calls.splice(0), [['links', 3]]); // Explicit refresh still reloads.

    for (const [hash, expected] of [
        ['#/c/42', ['collation', '42']],
        ['#/', ['links', 1]],
        ['#/newsletters', 'newsletters'],
    ]) {
        context.location.hash = hash;
        await context.route();
        assert.deepEqual(calls.pop(), expected);
    }
    context.cfg.token = '';
    context.location.hash = '#/l/42';
    await context.route();
    assert.equal(calls.pop(), 'setup');
    console.log('Route regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
