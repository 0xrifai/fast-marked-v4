# fast-marked-v4

[![make.fun bounty](https://img.shields.io/badge/make.fun-markdown--render--speed--02-blue)](https://make.fun/bounty/markdown-render-speed-02)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org/)

A faster drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3.

`parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns
with marked's default options (GFM on, breaks off, pedantic off, async off) —
byte for byte, on every input — while rendering the practice set about 1.5×
faster than marked itself.

## Layout

- `parse.js` — dependency-free ES module. Exports `parse(markdown)`.
  Single-pass block lexer plus an inline engine built on marked's delimiter
  algorithm for emphasis, strong emphasis and strikethrough, with sticky
  regexes and a hand-rolled text scanner so long documents stay linear.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\nSome *emphasis* and a [link](https://example.com).');
// '<h1>Hello</h1>\n<p>Some <em>emphasis</em> and a <a href="https://example.com">link</a>.</p>\n'
```

## Referral

Built for the make.fun bounty — referral code `6twtfdad`
(https://make.fun/r/6twtfdad).

## License

MIT — see [LICENSE](./LICENSE). marked itself is MIT, copyright MarkedJS.
