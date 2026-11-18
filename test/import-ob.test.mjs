// tools/import-ob.mjs 的测试。OB 文件夹全是在临时目录里现造的假数据，不碰任何真的记忆库。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, splitFront, convert, split, formatReport } from '../tools/import-ob.mjs';
import { openStore } from '../lib/store.mjs';

const SCRIPT = fileURLToPath(new URL('../tools/import-ob.mjs', import.meta.url));
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); // 自己建的临时目录自己清
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-imp-')); dirs.push(d); return d; };
const put = (root, rel, content) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); };

// 一个假的 OB 数据目录，写法照 PyYAML（python-frontmatter）实际写出来的样子：短横列表跟键对齐、时间带引号
const BODIES = [];
function fakeOb() {
  const root = tmp();
  const md = (rel, head, body) => { BODIES.push(body); put(root, rel, `---\n${head}\n---\n${body}\n`); };
  md('dynamic/日常/2026-04-01 10-00-00 吃面_aaa111.md', `activation_count: 3
arousal: 0.3
created: '2026-04-01T10:00:00+08:00'
domain:
- 日常
id: aaa111
importance: 5
last_active: '2026-04-03T09:00:00+08:00'
name: 2026-04-01 10-00-00 吃面
quotes:
- at: '2026-04-01'
  speaker: 她
  text: 测试：面好吃
- 测试：第二句
source_tool: hold
tags:
- 吃饭
- 测试
type: dynamic
valence: 0.8
why_remembered: 测试：这是一个很长很长的原因，长到 PyYAML 会把它折成两行写，续行要比键缩进得更深
  一些才对
fork_extra: 二改版多出来的字段`, '测试：今天吃了面');
  md('feel/沉淀物/feel_202604011000_V08.md', `id: feel_202604011000_V08
type: feel
created: '2026-04-01T11:00:00+08:00'
digested: true
tags: []`, '测试：吃完面很开心');
  md('plans/resolved/p1.md', 'id: p1\ntype: plan\nstatus: resolved\ncreated: \'2026-04-02T10:00:00+08:00\'', '测试：周末去爬山');
  md('plans/active/p2.md', "id: p2\ntype: plan\nstatus: active\nresolved: 'true'", '测试：学会做饭');
  md('plans/abandoned/p3.md', 'id: p3\ntype: plan\nstatus: abandoned', '测试：每天跑步');
  md('plans/active/p4.md', 'id: p4\ntype: plan\nstatus: active\nweight: 0.7', '测试：一起看电影');
  md('dynamic/self/i1.md', 'id: i1\ntype: i\ndomain:\n- self\ni_from_candidate: c9', '测试：我喜欢安静');
  md('dynamic/self/s1.md', 'id: s1\ntype: self', '测试：我说话偏直');
  md('permanent/核心/k1.md', 'id: k1\ntype: permanent\npinned: true', '测试：固有一');
  md('dynamic/未分类/k2.md', 'id: k2\ntype: dynamic\nanchor: true', '测试：坐标一');
  md('dynamic/未分类/k3.md', "id: k3\ntype: dynamic\nprotected: 'false'\npinned: false", '测试：不固有');
  md('letters/history/l1.md', 'id: l1\ntype: letter\nlock_type: none', '测试：一封信');
  md('archive/未分类/l2.md', 'id: l2\ntype: archived\nsource_tool: letter', '测试：归档的信');
  md('archive/未分类/a1.md', "id: a1\ntype: archived\nlast_active: '2026-03-01T08:00:00+08:00'\ncreated: '2026-02-01T08:00:00+08:00'", '测试：归档的旧事');
  md('archive/未分类/a2.md', 'id: a2\ntype: archived\nstatus: resolved\nchange_log:\n- at: \'2026-03-02\'\n  to: resolved', '测试：归档的约定');
  md('dynamic/未分类/long.md', 'id: long1\ntype: dynamic', '测试' + '长'.repeat(4100));
  // 坏文件：每种各一个
  put(root, 'dynamic/未分类/bad-open.md', '---\nid: bad1\n测试：头没收尾\n');
  put(root, 'dynamic/未分类/bad-yaml.md', '---\nid: bad2\n这一行没有冒号\n---\n测试：头读不懂\n');
  put(root, 'dynamic/未分类/bad-empty.md', '---\nid: bad3\n---\n   \n');
  fs.writeFileSync(path.join(root, 'dynamic/未分类/bad-bytes.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
  put(root, 'archive/未分类/dup.md', '---\nid: aaa111\ntype: archived\n---\n测试：同一条的第二份\n');
  // 不该被读的：数据目录里的别的东西、mac 的垃圾文件
  put(root, '_app/README.md', '测试：程序自带的说明，不是记忆');
  put(root, 'config.yaml', 'x: 1\n');
  put(root, 'dynamic/未分类/._k2.md', 'junk');
  put(root, 'dynamic/未分类/.DS_Store', 'junk');
  return root;
}

function snapshot(root) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { const st = fs.statSync(f); out[path.relative(root, f)] = st.mtimeMs + ':' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } } };
  walk(root);
  out['<dirs>'] = fs.readdirSync(root).sort().join(',');
  return out;
}
const byId = (data) => Object.fromEntries(data.items.map((m) => [m.id, m]));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('YAML：标量、引号、行内列表、短横列表、| 和 > 多行', () => {
  const y = parseYaml(`a: plain words
n: 42
f: 0.5
t: true
y: yes
z: ~
q1: 'it''s: ok'
q2: "line\\nbreak \\u4e2d"
q3: "折成
  一行"
q4: 'one

  two'
inline: [a, 'b c', "d", 3]
emptyl: []
emptym: {}
fm: {k: v, n: 1}
dash:
- x
- y
nested:
  - k: 1
    j: [2]
  - plain
lit: |
  第一行
    缩进的行

  第三行
folded: >-
  这两行
  会合成一行
weird: &anchor 原样留着
tagged: !!str 也原样
plainlong: 这是很长的
  续行
after: 1`);
  assert.equal(y.a, 'plain words');
  assert.equal(y.n, 42); assert.equal(y.f, 0.5); assert.equal(y.t, true); assert.equal(y.y, true); assert.equal(y.z, null);
  assert.equal(y.q1, "it's: ok");
  assert.equal(y.q2, 'line\nbreak 中');
  assert.equal(y.q3, '折成 一行');
  assert.equal(y.q4, 'one\ntwo');
  assert.deepEqual(y.inline, ['a', 'b c', 'd', 3]);
  assert.deepEqual(y.emptyl, []); assert.deepEqual(y.emptym, {});
  assert.deepEqual(y.fm, { k: 'v', n: 1 });
  assert.deepEqual(y.dash, ['x', 'y']);
  assert.deepEqual(y.nested, [{ k: 1, j: [2] }, 'plain']);
  assert.equal(y.lit, '第一行\n  缩进的行\n\n第三行\n');
  assert.equal(y.folded, '这两行 会合成一行');
  assert.equal(y.weird, '&anchor 原样留着');
  assert.equal(y.tagged, '!!str 也原样');
  assert.equal(y.plainlong, '这是很长的 续行');
  assert.equal(y.after, 1);
});

test('YAML 头：没有头的整篇当正文；没收尾、读不懂的报错', () => {
  assert.deepEqual(splitFront('测试：没有头'), { meta: {}, body: '测试：没有头' });
  assert.throws(() => splitFront('---\nid: x\n'), /没收尾/);
  assert.throws(() => splitFront('---\n没有冒号\n---\nx'));
  const { meta, body } = splitFront('﻿---\r\nid: x\r\n---\r\n测试：正文\r\n');
  assert.equal(meta.id, 'x');
  assert.equal(body.trim(), '测试：正文');
});

test('各种 type 的对应、固有、引语、次数和时间', () => {
  const root = fakeOb();
  const { data, report } = convert(root);
  const m = byId(data);
  const a = m['ob-aaa111'];
  assert.equal(a.kind, 'note'); assert.equal(a.by, 'ai'); assert.equal(a.text, '测试：今天吃了面');
  assert.deepEqual(a.kw, ['吃饭', '测试']);
  assert.match(a.why, /^测试：这是一个很长很长的原因.*续行要比键缩进得更深 一些才对$/);
  assert.equal(a.t, Date.parse('2026-04-01T10:00:00+08:00'));
  assert.equal(a.usedAt, Date.parse('2026-04-03T09:00:00+08:00'));
  assert.equal(a.used, 3);
  assert.equal(a.src, '她：测试：面好吃\n测试：第二句');
  assert.equal(a.pin, undefined);
  assert.equal(a.gone, undefined);
  assert.equal(m['ob-feel_202604011000_V08'].kind, 'exp');
  assert.equal(m['ob-p1'].kind, 'pact'); assert.equal(m['ob-p1'].st, '做到了');
  assert.equal(m['ob-p2'].st, '做到了'); // resolved: 'true'（字符串）也算
  assert.equal(m['ob-p3'].st, '不作数了');
  assert.equal(m['ob-p4'].st, '还作数');
  assert.equal(m['ob-i1'].kind, 'view'); assert.equal(m['ob-s1'].kind, 'view');
  assert.equal(m['ob-k1'].pin, true); assert.equal(m['ob-k2'].pin, true);
  assert.equal(m['ob-k3'].pin, undefined); // 'false' 字符串不算真
  assert.equal(m['ob-k1'].kind, 'note'); // permanent 照规矩也是 note
  assert.equal(m['ob-l1'], undefined); assert.equal(m['ob-l2'], undefined); // 信不转
  assert.equal(report.letters, 2);
  assert.deepEqual(report.kinds, { note: 6, pact: 5, view: 2, exp: 1 });
  for (const it of data.items) assert.equal(it.vec, undefined);
});

test('归档的带 gone，归档后原来的种类尽量猜回来', () => {
  const { data, report } = convert(fakeOb());
  const m = byId(data);
  assert.equal(m['ob-a1'].gone, Date.parse('2026-03-01T08:00:00+08:00'));
  assert.equal(m['ob-a1'].kind, 'note');
  assert.equal(m['ob-a2'].kind, 'pact'); assert.equal(m['ob-a2'].st, '做到了');
  assert.ok(m['ob-a2'].gone > 0); // 没有 last_active，用文件修改时间
  assert.equal(report.archived, 2);
});

test('我们没有的字段原样进 ob，一个不丢', () => {
  const m = byId(convert(fakeOb()).data);
  const ob = m['ob-aaa111'].ob;
  assert.equal(ob.valence, 0.8); assert.equal(ob.arousal, 0.3); assert.equal(ob.importance, 5);
  assert.deepEqual(ob.domain, ['日常']); assert.equal(ob.type, 'dynamic'); assert.equal(ob.source_tool, 'hold');
  assert.equal(ob.name, '2026-04-01 10-00-00 吃面');
  assert.equal(ob.fork_extra, '二改版多出来的字段');
  assert.equal(ob.quotes[0].speaker, '她'); // 引语原样也留一份（说话人、时间）
  for (const k of ['id', 'tags', 'why_remembered', 'created', 'last_active', 'activation_count']) assert.ok(!(k in ob), k);
  assert.equal(m['ob-feel_202604011000_V08'].ob.digested, true);
  assert.equal(m['ob-p2'].ob.resolved, 'true');
  assert.equal(m['ob-i1'].ob.i_from_candidate, 'c9');
  assert.equal(m['ob-k2'].ob.anchor, true);
});

test('坏文件跳过、分原因计数，不中断；数据目录里别的东西不读', () => {
  const { data, report } = convert(fakeOb());
  assert.equal(report.files, 21); // 只数 6 个记忆文件夹里的 .md，不含 _app、隐藏文件
  assert.deepEqual(report.skipped, { 'YAML 头没收尾': 1, 'YAML 头读不懂': 1, '正文是空的': 1, '不是 UTF-8 文字': 1, '编号重复（同一条存了两份）': 1 });
  assert.equal(report.out, data.items.length);
  assert.equal(report.files, report.out + report.letters + 5);
  assert.equal(report.longest, 4102);
  assert.equal(report.over, 1);
  assert.ok(!data.items.some((m) => /程序自带/.test(m.text)));
});

test('选错文件夹会说清楚', () => {
  const d = tmp();
  put(d, 'random.md', '---\nid: x\n---\n测试\n');
  assert.throws(() => convert(d), /是不是选错了/);
});

test('命令行：报告里没有正文，源文件夹一个字节没变；--dry 不写文件', () => {
  const root = fakeOb(), out = tmp();
  const before = snapshot(root);
  const dry = run(root, '--dry', '--out', path.join(out, 'x.json'));
  assert.equal(dry.status, 0, dry.stderr);
  assert.ok(!fs.existsSync(path.join(out, 'x.json')));
  assert.match(dry.stdout, /--dry/);
  const r = run(root, '--out', path.join(out, 'ob.json'), '--ai', 'yun');
  assert.equal(r.status, 0, r.stderr);
  for (const b of BODIES) for (const piece of [b, b.slice(0, 8)]) assert.ok(!(r.stdout + r.stderr + dry.stdout).includes(piece), '报告里漏了正文');
  assert.ok(!/测试：/.test(r.stdout + dry.stdout));
  assert.match(r.stdout, /一共读到 21 个/);
  assert.match(r.stdout, /\/api\/memory\/yun\/import/);
  assert.deepEqual(snapshot(root), before);
  const data = JSON.parse(fs.readFileSync(path.join(out, 'ob.json'), 'utf8'));
  assert.equal(data.ai, 'yun');
  assert.equal(data.items.length, 14);
  assert.equal(fs.statSync(path.join(out, 'ob.json')).mode & 0o777, 0o600);
});

test('命令行：--out 不许放进源文件夹；参数错了退出码 2', () => {
  const root = fakeOb();
  const before = snapshot(root);
  const r = run(root, '--out', path.join(root, 'x.json'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /不能放在/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(run().status, 2);
  assert.equal(run(root, '--ai', '坏 名字', '--dry').status, 2);
  assert.equal(run(root, '--what').status, 2);
});

test('太大就分几份，一条不丢不重', () => {
  const { data } = convert(fakeOb());
  const parts = split(data, 4000);
  assert.ok(parts.length > 1);
  const ids = parts.flatMap((p) => p.items.map((m) => m.id));
  assert.deepEqual(ids, data.items.map((m) => m.id));
  assert.equal(split(data).length, 1);
  assert.match(formatReport(convert(fakeOb()).report, { written: [{ file: 'a.1.json', n: 1, bytes: 10 }, { file: 'a.2.json', n: 1, bytes: 10 }] }), /分成了 2 个文件/);
});

test('转出来的东西真的能被 openStore().importAll 收进去', () => {
  const { data } = convert(fakeOb());
  const s = openStore({ dir: tmp(), tz: 'Asia/Shanghai' });
  const body = JSON.parse(JSON.stringify(data)); // 跟走一遍 HTTP 一样
  assert.equal(s.importAll('yun', body).added, data.items.length);
  const got = Object.fromEntries(s.load('yun').items.map((m) => [m.id, m]));
  assert.equal(got['ob-aaa111'].text, '测试：今天吃了面');
  assert.equal(got['ob-p1'].kind, 'pact');
  assert.equal(got['ob-feel_202604011000_V08'].kind, 'exp');
  assert.equal(got['ob-aaa111'].ob.fork_extra, '二改版多出来的字段');
  assert.equal(s.importAll('yun', body).added, 0); // 再导一次不会重复
});

test('导入时归档的标记留着：搬来的归档记忆进来还是归档，能恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
  try {
    const s = openStore({ dir });
    assert.equal(s.importAll('a', { items: [{ id: 'ob-1', text: '测试：归档的', by: 'ai', gone: 1700000000000 }, { id: 'ob-2', text: '测试：正常的', by: 'ai' }] }).added, 2);
    assert.deepEqual(s.list('a').items.map((m) => m.id), ['ob-2']);
    assert.deepEqual(s.list('a', { gone: true }).items.map((m) => m.id), ['ob-1']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
