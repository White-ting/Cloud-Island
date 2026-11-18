// 思考翻译：用哪家（设置里的「翻译」优先，其次 .env），都没配就关；缓存、失败的那段回空
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTranslate, chatUrl } from '../lib/translate.mjs';
import { openSvc } from '../lib/svc.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
const reply = (o) => ({ ok: true, status: 200, json: async () => o });
const okFetch = (calls) => async (url, o) => { calls.push({ url, auth: o.headers.authorization, model: JSON.parse(o.body).model }); const b = JSON.parse(o.body); return reply({ choices: [{ message: { content: '译：' + b.messages[1].content } }] }); };

test('都没配：关着，接口回 503 和一句人话；status 说 off', async () => {
  const t = openTranslate({ dir: tmp(), fetchFn: async () => { throw new Error('不该调'); } });
  assert.deepEqual(t.status(), { on: false });
  assert.throws(() => t.run({ texts: ['hello there'] }), (e) => e.code === 503 && /没配翻译/.test(e.message));
});

test('.env 那三项：地址补上 /chat/completions、带 key；翻过的走缓存，不是英文的不翻', async () => {
  const calls = [];
  const t = openTranslate({ dir: tmp(), env: { base: 'http://127.0.0.1:1/v1/', model: 'm-env', key: 'k1' }, fetchFn: okFetch(calls) });
  assert.deepEqual(t.status(), { on: true, model: 'm-env' });
  const a = await t.run({ texts: ['Hello there', '已经是中文了', ''] });
  assert.deepEqual(a.by, ['api', 'skip', 'skip']);
  assert.equal(a.zh[0], '译：Hello there');
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:1/v1/chat/completions', auth: 'Bearer k1', model: 'm-env' });
  const b = await t.run({ texts: ['Hello there'] });
  assert.deepEqual(b.by, ['cache']);
  assert.equal(calls.length, 1);
});

test('设置里的「翻译」填了就用它（比 .env 优先）；没 key 不带 authorization；缓存写在盘上，重开也认', async () => {
  const dir = tmp(), calls = [];
  const svc = openSvc({ dir });
  svc.putFm('trans', { url: 'http://127.0.0.1:2/v1/chat/completions', model: 'm-svc' });
  const t = openTranslate({ dir, svc, env: { base: 'http://127.0.0.1:1/v1', model: 'm-env' }, fetchFn: okFetch(calls) });
  await t.run({ texts: ['first one'] });
  assert.deepEqual(calls[0], { url: 'http://127.0.0.1:2/v1/chat/completions', auth: undefined, model: 'm-svc' });
  const t2 = openTranslate({ dir, svc, fetchFn: async () => { throw new Error('不该再问'); } });
  assert.deepEqual((await t2.run({ texts: ['first one'] })).zh, ['译：first one']);
});

test('服务出错：那一段回空、标 fail，不整个报错；参数不对报 400', async () => {
  const logs = [];
  const t = openTranslate({ dir: tmp(), env: { base: 'http://x/v1', model: 'm' }, fetchFn: async () => ({ ok: false, status: 500, json: async () => ({}) }), log: (...a) => logs.push(a.join(' ')) });
  const a = await t.run({ texts: ['some words'] });
  assert.deepEqual(a, { ok: true, zh: [''], by: ['fail'] });
  assert.match(logs[0], /500/);
  assert.throws(() => t.run({}), /texts/);
  assert.throws(() => t.run({ texts: Array(21).fill('a') }), /最多/);
  assert.equal(chatUrl('https://a.b/v1'), 'https://a.b/v1/chat/completions');
});
