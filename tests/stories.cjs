const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
let response, rendered, title, failure;
const requests = [], selections = [];
const context = vm.createContext({
    cfg: { project: '7' },
    $: () => ({}),
    h: (tag, attrs, ...children) => ({ tag, ...attrs, children: children.flat(Infinity).filter(Boolean) }),
    safeUrl: value => /^https:\/\//.test(value || '') ? value : null,
    emphasised: value => value,
    labelled: (label, value) => value ? `${label}: ${value}` : null,
    sensoriumUrl: (kind, id) => `${kind}/${id}`,
    sensoriumBtn: url => url,
    note: value => value,
    chrome: options => { title = options.title; },
    show: (...nodes) => { rendered = nodes.flat(Infinity).filter(Boolean); },
    showLink: (link, level) => selections.push([link.id, level]),
    fail: error => { failure = error; },
    cachedApi: async path => { requests.push(path); if (response instanceof Error) throw response; return response; },
});
vm.runInContext(source.slice(source.indexOf('    function storyBody('), source.indexOf('    // ---------- contents navigator')), context);
const walk = node => typeof node === 'object' ? [node, ...(node.children || []).flatMap(walk)] : [node];

(async () => {
    response = { data: { data: { id: 8, title: 'Reader title', summary: 'Reader summary',
        image_url: 'https://example.com/image.jpg', links: [
            { id: 12, title: 'First source', publisher_name: 'Publisher' },
            { id: 10, title: 'Second source' },
        ] } }, stale: true };
    await context.viewStory('8');
    assert.deepEqual(requests, ['/projects/7/stories/8/reader']);
    assert.equal(title, 'Reader title');
    const nodes = rendered.flatMap(walk);
    assert.ok(nodes.includes('Reader summary'));
    assert.ok(nodes.includes('Offline — showing saved copy.'));
    assert.equal(nodes.find(node => node.tag === 'img').src, 'https://example.com/image.jpg');
    const sources = nodes.filter(node => node.class === 'link-row');
    sources.forEach(node => node.onclick());
    assert.deepEqual(selections, [[12, 'main'], [10, 'main']]);
    assert.ok(!nodes.some(node => typeof node === 'string' && node.startsWith('Editorial commentary:')));

    response = { data: { data: { id: 8, title: 'Empty story', summary: null, image_url: null, links: [] } } };
    await context.viewStory('8');
    assert.ok(rendered.flatMap(walk).includes('Sources (0)'));
    assert.equal(failure, undefined);

    response = new Error('Story not found');
    await context.viewStory('404');
    assert.equal(failure, response);
    console.log('Story reader regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
