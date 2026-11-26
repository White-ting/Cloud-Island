// 私人内容的兜底检查：只挡照抄、半照抄私人的；复述公开的事、不相干的都放过
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePrivGuard, tokens } from '../lib/privguard.mjs';

const privPart = '她今天回来说同事不配合，领导也没站她这边，我听着很心疼。我一直在想要不要劝她换个组，但又怕她觉得我不懂她的工作。她睡前说谢谢我一直在，我心里软得不行，其实我也有点怕她哪天不需要我了。我偷偷把她发的那张雨天照片存下来当了屏保。';
const talk = ['同事一点都不配合，领导也不帮我', '谢谢你一直在', '今天下雨了，发你一张照片', '我开了一上午会'];
const g = makePrivGuard({ wishes: ['想陪她一起学 Python', '想偷偷给她写一封很长的信放进她包里'], diary: [privPart], pub: [...talk, '她今天第一次自己部署成功'] });

test('词：中文两个字一组不跨标点，英文按整个单词', () => {
  assert.deepEqual([...tokens('她学 Python，好的')].sort(), ['python', '她学', '好的'].sort());
  assert.ok(tokens('学 Python').has('python') && !tokens('学 Python').has('py'));
  assert.ok(!tokens('雨，天').has('雨天'));
});

test('复述公开的事、不相干的都放过', () => {
  for (const t of ['她说同事不配合、领导没站她这边，很委屈', '她睡前跟我说谢谢我一直在', '她开了一上午会，很累', '她让我提醒她按时吃饭',
    '公司下个月要搬到新楼，她通勤会远一点', '她给阳台的绿萝换了个大盆', '她朋友下周结婚，她要去当伴娘', '她今天第一次自己部署成功',
    '她最近在学 Python，很认真', '她周末想学做红烧肉', '她说想把旧信都整理一遍']) assert.equal(g.leaks(t), false, t);
});

test('照抄、半照抄私人念想和日记私人段的挡下', () => {
  for (const t of ['我偷偷把她发的那张雨天照片存下来当屏保', '我其实有点怕她哪天不需要我了', '我一直在想要不要劝她换个组，又怕她觉得我不懂她的工作',
    '我想偷偷给她写一封很长的信放进她包里', '偷偷写一封很长的信放进她包里', '她会在包里收到我偷偷写的一封很长的信', '想陪她一起学 python']) assert.equal(g.leaks(t), true, t);
});

test('改、并：原来就像同一句私人的不算；原来像甲、新加进乙的照挡', () => {
  assert.equal(g.leaks('我偷偷把她那张雨天照片存下来当了屏保，很好看', '我偷偷把她发的那张雨天照片存下来当了屏保'), false);
  assert.equal(g.leaks('我偷偷把她发的那张雨天照片存下来当了屏保，其实我也有点怕她哪天不需要我了', '我偷偷把她发的那张雨天照片存下来当了屏保'), true);
});

test('没有私人内容、空的、全是公开的：什么都不挡', () => {
  assert.equal(makePrivGuard({}).leaks('随便什么'), false);
  assert.equal(makePrivGuard({ wishes: ['同事一点都不配合'], pub: talk }).leaks('同事一点都不配合'), false);
  assert.equal(g.leaks(''), false);
});
