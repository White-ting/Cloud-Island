// 往外发请求前的检查（网页设置里填的地址用：出声、认字、翻译、旁听的小模型、Bark）。
// 默认只许 https 的公网地址；明文 http、本机、局域网、Tailscale 这类私网地址一律不许，
// 除非这台电脑的管理员在 .env 的 ALLOW_URLS 里写了放行（比如本机的 Ollama：http://127.0.0.1:11434）。
// .env、ais.json 里写的地址是管理员自己写的，不走这里。
//
// 局限（照实说）：这里先用 node:dns 把域名解析一遍，看每个地址是不是私网；真正发请求时 fetch 会再解析一次。
// 两次之间 DNS 换了答案（DNS 重绑定）就拦不住——Node 自带的 fetch 没法指定「就连这个 IP」。
// 所以这只是挡住「填个内网地址 / 指向内网的域名」这种直接的做法，不是完整的防护。
// 另外所有出站请求都带 redirect: 'error'：上游回跳转一律当失败，不跟过去。
import dns from 'node:dns';
import net from 'node:net';
import { fail } from './store.mjs';

// 私网、本机、保留的地址段（IPv4 映射成 IPv6 的 ::ffff:a.b.c.d 也认）
// 198.18.0.0/15 在名单里：网址里直接写这一段的 IP 照样拦。但 Clash、Surge 这类代理的 fake-ip 模式会把所有域名都解析成这一段的假地址，
// 所以「域名解析出来是这一段」放行（见 check 里的 FAKE），不然开着代理的人填任何公网服务都会报「指向局域网」。
const BLOCK = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCK.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2001:db8::', 32]]) BLOCK.addSubnet(a, n, 'ipv6');

const FAKE = new net.BlockList(); FAKE.addSubnet('198.18.0.0', 15, 'ipv4');
const fakeIp = (ip) => { const s = String(ip || '').replace(/^::ffff:/i, ''); return net.isIPv4(s) && FAKE.check(s, 'ipv4'); };

export function privateIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (m) return BLOCK.check(m[1], 'ipv4');
  const v = net.isIP(s);
  if (!v) return true; // 认不出的当私网，不放
  return BLOCK.check(s, v === 4 ? 'ipv4' : 'ipv6');
}

// ALLOW_URLS 的一项：http://127.0.0.1:11434（只放这个端口）或 http://127.0.0.1（这台主机所有端口）
function parseAllow(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean)) {
    let u; try { u = new URL(raw); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const anyPort = !/^[a-z]+:\/\/(\[[^\]]*\]|[^/:]*):\d+/i.test(raw);
    out.push({ protocol: u.protocol, hostname: u.hostname.toLowerCase(), port: u.port || (u.protocol === 'https:' ? '443' : '80'), anyPort });
  }
  return out;
}
const portOf = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');

// allow：ALLOW_URLS（字符串或数组）；lookup：测试里换成假的
export function makeNet({ allow = '', lookup = dns.promises.lookup } = {}) {
  const rules = parseAllow(allow);
  const allowed = (u) => rules.some((r) => r.protocol === u.protocol && r.hostname === u.hostname.toLowerCase() && (r.anyPort || r.port === portOf(u)));
  // 不查 DNS 的那一半：填设置时就能先说（http、写死的私网 IP、localhost）
  function okSync(s, what = '地址') {
    let u; try { u = new URL(String(s)); } catch { throw fail(400, `${what}写得不对`); }
    if (allowed(u)) return u;
    if (u.protocol !== 'https:') throw fail(400, `${what}要用 https。本机或局域网的服务（http）要先在 .env 的 ALLOW_URLS 里放行`);
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || (net.isIP(h) && privateIp(h))) throw fail(400, `${what}是本机或局域网的地址：要先在 .env 的 ALLOW_URLS 里放行`);
    return u;
  }
  // 发请求前：再解析一遍域名，任何一个地址落在私网就不发
  async function check(s, what = '地址') {
    const u = okSync(s, what);
    if (allowed(u)) return u;
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(h)) return u;
    let addrs;
    try { addrs = await lookup(h, { all: true }); } catch { throw fail(502, `${what}的域名解析不出来`); }
    if (!addrs?.length || addrs.some((a) => privateIp(a.address) && !fakeIp(a.address))) throw fail(400, `${what}的域名指向本机或局域网：要先在 .env 的 ALLOW_URLS 里放行`);
    return u;
  }
  return { okSync, check, allowed: (s) => { try { return allowed(new URL(String(s))); } catch { return false; } } };
}

// 规范化的 origin（凭据绑定用）：协议 + 主机 + 端口，认不出回空
export const originOf = (s) => { try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };
