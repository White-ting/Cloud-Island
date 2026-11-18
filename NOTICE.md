# 出处

本仓库自己的代码照 LICENSE（公开源码版：源码公开，但不是开源许可，自用自改，不许转发、不许商用）。下面这些第三方的东西照它们自己的许可。

## 霞鹜文楷（开屏中文字幕的字体）

web/ 下的 `lxgwwenkai-light-subset-*.woff2` 和 `lxgwwenkai-light.css`：

- 字体：LXGW WenKai（霞鹜文楷），作者 LXGW，许可 SIL Open Font License 1.1，全文见 `web/LXGW-WenKai-OFL.txt`
- 网页切片和样式表：npm 包 lxgw-wenkai-webfont@1.7.0（Chawye Hsu），许可 MIT，全文见 `web/lxgw-wenkai-webfont-LICENSE-MIT.txt`
- 改了两处：字体文件和样式表放在同一层（url 去掉 `files/`）；`font-display` 改成 `block`。

## DeepSeek Harness（dsh，可选）

`lib/dsh.mjs` 只是按 dsh 官方的 SDK 协议（JSON-RPC over stdio）去启动和驱动你自己装的 dsh，本仓库不带 dsh 的任何代码。
dsh 是 DeepSeek 开源的智能体（https://github.com/deepseek-ai/deepseek-harness，MIT），要用请自己装，照它的许可。

## Ombre Brain（记忆召回的思路）

lib/vec.mjs 的向量召回和 lib/store.mjs 里召回打分那段，思路改自 Ombre Brain：

- 项目：Ombre Brain（https://github.com/P0luz/Ombre-Brain）
- 许可：MIT
- 版权声明：Copyright (c) 2026 P0lar1zzZ

这里是用 JavaScript 重写的，没有拷原来的代码。改了的地方：相不相关和新不新分开算（相关性只决定进不进，新旧只用来排序）；不自动归档、不删、不改档位；不调外部模型判断要不要合并。
