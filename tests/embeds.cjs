const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
const did = 'did:plc:abc123';
const requests = [];
const context = vm.createContext({
    URL,
    safeUrl: value => value,
    h: (tag, attributes) => ({ tag, ...attributes }),
    fetch: async (url, options) => {
        requests.push(url);
        assert.equal(options.credentials, 'omit');
        return { ok: true, json: async () => ({ did }) };
    },
});
vm.runInContext(source.slice(source.indexOf('    function linkEmbed('), source.indexOf('    function linkBody(')), context);

(async () => {
    for (const account of ['alice.bsky.social', did, encodeURIComponent(did)]) {
        const frame = context.linkEmbed({
            content_type: 'social_post', platform: 'bluesky',
            url: `https://bsky.app/profile/${account}/post/3abc123`,
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(frame.tag, 'iframe');
        assert.equal(frame.src, `https://embed.bsky.app/embed/${did}/app.bsky.feed.post/3abc123`);
    }
    assert.deepEqual(requests, [
        'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alice.bsky.social',
    ]);
    console.log('Embed regression checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
