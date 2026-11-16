// fast-marked-v4 — a faster drop-in replacement for marked 18.1.3.
// parse(markdown) returns exactly the HTML that marked.parse(markdown)
// returns with marked's default options (gfm: true, breaks: false,
// pedantic: false, async: false). Dependency-free, single file.
// Written in this session from the CommonMark 0.31.2 / GFM 0.29 specs and
// marked 18.1.3's published grammar.

/* =============== scalar helpers =============== */

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPE_MAP[ch];

// Escape, keeping a valid named or numeric entity untouched.
const ENTITY_SAFE_ESCAPE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const PLAIN_ESCAPE = /[&<>"']/g;
function escapeText(s) {
  return ENTITY_SAFE_ESCAPE.test(s) ? s.replace(ENTITY_SAFE_ESCAPE, escapeChar) : s;
}
function escapeAll(s) {
  return PLAIN_ESCAPE.test(s) ? s.replace(PLAIN_ESCAPE, escapeChar) : s;
}

const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_BARE_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
// Decode numeric character references (named entities pass through);
// a bare & becomes &amp;. Mirrors marked's unescape().
function decodeNumericRefs(s) {
  if (!NUMERIC_REF.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_BARE_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

// marked's cleanUrl: encodeURI, then turn %25 back into %.
function cleanUrl(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}

// Link-label normalisation: trim, collapse whitespace, Unicode-aware lowercase.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs in s, counting columns from col.
function expandTabs(s, col) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += ch; t++; }
  }
  return out;
}

// Parenthesis balance in a link destination: index of the unbalanced ')',
// -2 when a '(' is left unclosed, -1 when balanced (or no parens at all).
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth < 0) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Trim trailing newline characters.
function stripTrailingNewlines(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 10) n--;
  return s.slice(0, n);
}

// Strip trailing blank lines from an HTML block, keeping at most 2 newlines.
function trimHtmlBlock(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Trim trailing characters equal to the given char code.
function trimTrailingChar(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Trim trailing backslashes.
function trimTrailingBackslashes(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 92) n--;
  return s.slice(0, n);
}

/* =============== block grammar (marked 18.1.3, GFM) =============== */

const BLOCK_TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_START = `<\\/?(?:${BLOCK_TAG_NAMES})(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[`;
const HR_PATTERN = `(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,}`;
const FENCE_OPEN_PATTERN = `(?:\`{3,}(?=[^\`\\n]*(?:\\n|$))|~~~)`;

const newlineRe = /^(?:[ \t]*(?:\n|$))+/;
const indentedCodeRe = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const fencesRe = new RegExp("^ {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)\\1`*|(?=~)\\1~*) *(?=\\n|$)|$)", "");
const atxHeadingRe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const hrRe = new RegExp(`^ {0,3}(${HR_PATTERN})(?:\\n+|$)`);
const htmlBlockRe = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i");
const linkDefRe = new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)", "");
const listStartRe = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const setextHeadingRe = new RegExp(`^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:\`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:${HR_PATTERN})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)`);
const tableRe = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", "");
const paragraphRe = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", "");
const textLineRe = /^[^\n]+/;
const blockquoteRe = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", "");

const listItemRe = (marker) => new RegExp(`^( {0,3}${marker})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const nextBulletRe = (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const hrAtRe = (n) => new RegExp(`^ {0,${n}}(${HR_PATTERN})(?:\\n+|$)`);
const fencesAtRe = (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
const headingAtRe = (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
const htmlAtRe = (n) => new RegExp(`^ {0,${n}}(?:<\\/?(?:${BLOCK_TAG_NAMES})(?: +|$|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const bqAtRe = (n) => new RegExp(`^ {0,${n}}>`);

/* other small block patterns */
const CODE_INDENT_STRIP = /^(?: {0,3}\t| {1,4})/gm;
const LEADING_WS = /^[ \t]+/;
const NON_SPACE = /[^ ]/;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK_END = /\n[ \t]*\n[ \t]*$/;
const TASK_ITEM = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX = /^\[[ xX]\][ \t]+/;
const TASK_CHECKBOX = /\[[ xX]\]/;
const TABLE_TRIM_PIPES = /^\||\| *$/g;
const TABLE_TRAILING_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const TABLE_HAS_DELIM = /[:|]/;
const STARTS_WITH_ANGLE = /^</;
const ENDS_WITH_ANGLE = />$/;
const ANGLE_WRAPPED = /^<(.*)>$/;
const BACKSLASH_PUNCT = /\\([\p{P}\p{S}])/gu;
const LINK_BRACKET_ESCAPES = /\\([\[\]])/g;
const BQ_LINE_START = /^ {0,3}>/;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_STRIP_MARKER = /^ {0,3}>[ \t]?/gm;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const FENCE_INDENT = /^(\s+)(?:```)/;
const LEADING_SPACES = /^\s+/;

/* =============== inline grammar (marked 18.1.3, GFM) =============== */

const inlineEscapeRe = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const inlineTagRe = new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", "");
const inlineLinkRe = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", "");
const inlineRefLinkRe = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", "");
const inlineNoLinkRe = new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", "");
const emOpenRe = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const emCloseAstRe = new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu");
const emCloseUndRe = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const codeSpanRe = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const hardBreakRe = new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", "");
const delRe = new RegExp("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)", "");
const delOpenRe = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const delCloseRe = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const autolinkRe = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const extUrlRe = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// Sticky (y) twins of the per-position inline regexes: they match at lastIndex
// on the original string, so the inline loop never slices s per iteration
// (a per-token s.slice(i) is O(n^2) on long paragraphs). The leading ^ of
// each ^-anchored pattern is dropped; y already anchors at lastIndex.
// dropAnchors only removes ^ at the pattern start or after a top-level |,
// never the ^ of a negated [^...] class.
const dropAnchors = (src) => src.replace(/(^|\|)\^/g, '$1');
const inlineEscapeY = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const inlineTagY = new RegExp(dropAnchors(inlineTagRe.source), 'y');
const inlineLinkY = new RegExp(dropAnchors(inlineLinkRe.source), 'y');
const inlineRefLinkY = new RegExp(dropAnchors(inlineRefLinkRe.source), 'y');
const inlineNoLinkY = new RegExp(dropAnchors(inlineNoLinkRe.source), 'y');
const emOpenY = new RegExp(dropAnchors(emOpenRe.source), 'uy');
const codeSpanY = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const hardBreakY = new RegExp(dropAnchors(hardBreakRe.source), 'y');
const autolinkY = new RegExp(dropAnchors(autolinkRe.source), 'y');
const extUrlY = new RegExp(dropAnchors(extUrlRe.source), 'y');
const delOpenY = new RegExp(dropAnchors(delOpenRe.source), 'uy');
const urlBackpedalRe = new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", "");
const linkSkipRe = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");
const refLinkSearchRe = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;
const punctOrCodeRe = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const punctStartRe = /^((?![*_])[\s\p{P}\p{S}])/u;
const unicodeAlnumRe = /[\p{L}\p{N}]/u;
const preOpenRe = /^<(pre|code|kbd|script)(\s|>)/i;
const preCloseRe = /^<\/(pre|code|kbd|script)(\s|>)/i;
const anchorOpenRe = /^<a /i;
const anchorCloseRe = /^<\/a>/i;
// Fast path: if none of these appear, the inline string is plain text.
const INLINE_TRIGGER = /[\\<\[`*!_~@]| {2,}\n|www\.|https?|ftp|mailto:|xmpp:/i;
// First non-whitespace at/after lastIndex (scanText's hard-break (?!\s*$) check).
const NON_WS_GLOBAL = /\S/g;

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isEmailLocalCode(c) {
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 96 ||
    c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

/* =============== inline masking (for emphasis / del closers) =============== */

// Last index in the masked string where an emphasis / del closer run may start.
function lastCloserPositions(masked) {
  let star = -1, under = -1, tilde = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const c = masked[i];
    if (c !== '*' && c !== '_' && c !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (c === '~') tilde = i;
      else if (c === '*') star = i;
      else under = i;
    }
    let j = i + 1;
    while (j < n && masked[j] === c) j++;
    i = j - 1;
  }
  return { star, under, tilde };
}

function textContainsLink(s, refs) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(linkSkipRe)) {
    if (inlineLinkRe.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(refLinkSearchRe)) {
    const r = m[0], o = r.lastIndexOf('[');
    if (!(r.charAt(0) === '!' || !refs.has(normalizeLabel(r.slice(o + 1, -1)))) &&
        !(o > 1 && textContainsLink(r.slice(1, o - 1), refs))) return true;
  }
  return false;
}

function maskRefLinks(t, refs) {
  const re = new RegExp(refLinkSearchRe.source, 'g');
  let out = '', last = 0, m;
  while ((m = re.exec(t)) !== null) {
    const r = m[0], o = r.lastIndexOf('[');
    let rep = r;
    if (refs.has(normalizeLabel(r.slice(o + 1, -1)))) {
      if (o > 1 && r.charAt(0) !== '!' && textContainsLink(r.slice(1, o - 1), refs)) {
        rep = '[' + maskRefLinks(r.slice(1, o - 1), refs) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      } else {
        rep = '[' + 'a'.repeat(r.length - 2) + ']';
      }
    }
    out += t.slice(last, m.index) + rep;
    last = m.index + r.length;
  }
  return out + t.slice(last);
}

// Masked copy of an inline string: link spans, code spans and tags become [aaa...],
// backslash-escaped punctuation becomes ++, so emphasis/del closers cannot see
// through them. Length is preserved, so positions line up with the real string.
function maskInline(s, refs) {
  let t = s;
  if (refs.size > 0 && s.includes('[')) t = maskRefLinks(t, refs);
  // The two replaces can only match when these chars are present; skipping
  // them saves two full-string scans on plain emphasis text.
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(punctOrCodeRe, (m, codeRun, escCh) => {
      if (escCh !== undefined) return '+'.repeat(m.length);
      if (codeRun !== undefined) return codeRun + m.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun;
      return m;
    });
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(linkSkipRe, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  }
  return t;
}

/* =============== emphasis / strikethrough (marked's delimiter algorithm) =============== */

function tryEmphasis(s, masked, pos, closers, prevChar) {
  emOpenY.lastIndex = pos;
  const m = emOpenY.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const r = m[0][0];
  const o = prevChar === r;
  let n = prevChar;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  let p = '';
  if (l > 0) {
    const cps = [...masked.slice(l - 2 < 0 ? 0 : l - 2, l)];
    if (cps.length) p = cps[cps.length - 1];
  }
  const h = p === '*' || p === '_' || !!punctStartRe.exec(p);
  if (l < i) n = p;
  const u = l < i ? h : !!punctStartRe.exec(n);
  if (m[4] && unicodeAlnumRe.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (d && n && !u) return null; // search only when !d || !n || u
  const k = [...m[0]].length - 1;
  let mm = k, f = 0;
  const y = i - l + k;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  if (r !== '*' && r !== '_') return null;
  const A = r === '*' ? emCloseAstRe : emCloseUndRe;
  const v = r === '*' ? closers.star : closers.under;
  const Q = i + k;
  if (v < Q) return null;
  const t2 = masked.slice(pos + k);
  const ee = v - Q;
  A.lastIndex = 0;
  let s2;
  while ((s2 = A.exec(t2)) !== null && !(s2.index > ee)) {
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    let b = [...g].length;
    if (s2[3] || s2[4]) { mm += b; continue; }
    else if (s2[5] || s2[6] || R) {
      if (o && (s2[5] || s2[6])) break;
      if (y % 3 && !((y + b) % 3)) { f += b; continue; }
    }
    mm -= b;
    if (mm > 0) continue;
    b = Math.min(b, b + mm + f);
    const te = [...s2[0]][0].length;
    const M = s.slice(pos, pos + k + s2.index + te + b);
    if (Math.min(k, b) % 2) return { raw: M, text: M.slice(1, -1), strong: false };
    return { raw: M, text: M.slice(2, -2), strong: true };
  }
  return null;
}

function tryStrikethrough(s, masked, pos, closers, prevChar) {
  delOpenY.lastIndex = pos;
  const m = delOpenY.exec(s);
  if (!m) return null;
  const n = prevChar;
  if (!((m[1] || '') === '' || !n || punctStartRe.exec(n))) return null;
  const o = [...m[0]].length - 1;
  let p = o;
  const u = closers.tilde;
  const d = pos + o;
  if (u < d) return null;
  const t2 = masked.slice(pos + o);
  const kk = u - d;
  delCloseRe.lastIndex = 0;
  let s2;
  while ((s2 = delCloseRe.exec(t2)) !== null && !(s2.index > kk)) {
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== o) continue;
    if (s2[3] || s2[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const te = [...s2[0]][0].length;
    const raw = s.slice(pos, pos + o + s2.index + te + l);
    return { raw, text: raw.slice(o, -o) };
  }
  return null;
}

/* =============== links =============== */

// True when the label contains a tag/autolink that runs past the label's end.
function labelOverruns(full, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const c = codeSpanRe.exec(label.slice(i));
      if (c) { i += c[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const r = full.slice(offset + i);
    const o = inlineTagRe.exec(r) || autolinkRe.exec(r);
    if (o) {
      if (o[0].length > label.length - i) return true;
      i += o[0].length - 1;
    }
  }
  return false;
}

// Build a link/image from a matched label + href/title, parsing the label text.
// Returns { raw, out } or null when the link is invalid (a link inside a link).
function buildLink(labelRaw, isImg, href, title, raw, ctx, plain, autolink) {
  const st = ctx.st;
  if (autolink) {
    if (plain) return { raw, out: labelRaw };
    const h = cleanUrl(href);
    if (h === null) return { raw, out: escapeAll(labelRaw) };
    return { raw, out: '<a href="' + escapeAll(h) + '">' + escapeAll(labelRaw) + '</a>' };
  }
  const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRaw;
  st.inLink = true; st.linkEmitted = false;
  const inner = renderInline(labelRaw, ctx, isImg || plain);
  const innerHadLink = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImg) {
    if (innerHadLink) { st.inRaw = savedRaw; return null; }
    st.linkEmitted = true;
  }
  if (isImg) {
    if (plain) return { raw, out: inner };
    const h = cleanUrl(href);
    if (h === null) return { raw, out: escapeAll(inner) };
    let o = '<img src="' + escapeText(h) + '" alt="' + escapeText(inner) + '"';
    if (title) o += ' title="' + escapeText(title) + '"';
    return { raw, out: o + '>' };
  }
  if (plain) return { raw, out: inner };
  const h = cleanUrl(href);
  if (h === null) return { raw, out: inner };
  let o = '<a href="' + escapeText(h) + '"';
  if (title) o += ' title="' + escapeText(title) + '"';
  return { raw, out: o + '>' + inner + '</a>' };
}

function tryInlineLink(s, pos, ctx, plain) {
  if (!ctx.st.linkParenPossible) return null;
  inlineLinkY.lastIndex = pos;
  const m = inlineLinkY.exec(s);
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelOverruns(s.slice(pos), m[1], n)) return null;
  let dest = m[2].trim();
  let raw = m[0];
  let titlePart = m[3];
  if (dest.charAt(0) === '<') {
    if (!ENDS_WITH_ANGLE.test(dest)) return null;
    const stripped = trimTrailingBackslashes(dest.slice(0, -1));
    if ((dest.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2]);
    if (bal === -2) return null;
    if (bal > -1) {
      const h = (isImg ? 5 : 4) + m[1].length + bal;
      dest = m[2].substring(0, bal).trim();
      raw = raw.substring(0, h).trim();
      titlePart = '';
    }
  }
  const r2 = trimTrailingBackslashes(raw.slice(0, -1));
  if ((raw.length - r2.length) % 2 === 0) return null;
  let href = dest.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  const title = titlePart ? titlePart.slice(1, -1).replace(BACKSLASH_PUNCT, '$1') : '';
  href = href.replace(BACKSLASH_PUNCT, '$1');
  return buildLink(m[1].replace(LINK_BRACKET_ESCAPES, '$1'), isImg, href, title, raw, ctx, plain, false);
}

function tryReferenceLink(s, pos, ctx, plain) {
  inlineRefLinkY.lastIndex = pos;
  const m = inlineRefLinkY.exec(s) || (inlineNoLinkY.lastIndex = pos, inlineNoLinkY.exec(s));
  if (!m) return null;
  const isImg = m[0].charAt(0) === '!';
  const n = isImg ? 2 : 1;
  if (labelOverruns(s.slice(pos), m[1], n)) return null;
  const ref = ctx.refs.get(normalizeLabel(m[2] || m[1]));
  if (!ref) return { raw: m[0].charAt(0), out: plain ? m[0].charAt(0) : m[0].charAt(0) };
  return buildLink(m[1].replace(LINK_BRACKET_ESCAPES, '$1'), isImg, ref.href, ref.title, m[0], ctx, plain, false);
}

function tryExtendedUrl(s, pos, ctx, plain) {
  extUrlY.lastIndex = pos;
  const m = extUrlY.exec(s);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[0]; href = 'mailto:' + m[0]; }
  else {
    let t0 = m[0], prev;
    do { prev = t0; t0 = urlBackpedalRe.exec(t0)?.[0] ?? ''; } while (prev !== t0);
    text = t0;
    href = m[1] === 'www.' ? 'http://' + t0 : t0;
  }
  return buildLink(text, false, href, '', text, ctx, plain, true);
}

/* =============== text-run scanner =============== */

// Kind table for scanTextRun: 0 ordinary, 1 simple stop (\ < [ ` * _ ~),
// 2 '!' (stop only before '['), 3 space (hard-break run), 4 '@' (email),
// 5 w/W (www.), 6 m/M/x/X (mailto:/xmpp:), 7 h/H (http/https), 8 f/F (ftp).
const SCAN_KIND = new Uint8Array(128);
for (const c of [92, 60, 91, 96, 42, 95, 126]) SCAN_KIND[c] = 1;
SCAN_KIND[33] = 2; SCAN_KIND[32] = 3; SCAN_KIND[64] = 4;
SCAN_KIND[119] = 5; SCAN_KIND[87] = 5;
SCAN_KIND[109] = 6; SCAN_KIND[77] = 6; SCAN_KIND[120] = 6; SCAN_KIND[88] = 6;
SCAN_KIND[104] = 7; SCAN_KIND[72] = 7;
SCAN_KIND[102] = 8; SCAN_KIND[70] = 8;

// End index of the text run starting at i in s (first char always consumed).
// A leading backtick run is consumed whole (marked's text token starts `+).
// Hand-rolled char scan: a regex exec per run was a hot spot.
// Stops exactly where marked's inline text token stops: at \, <, [, `, *, _,
// ~, at '!' before '[', at '  \n', at a valid www./scheme/mailto:/xmpp:
// trigger, and at the start of an email local part before '@'.
function scanTextRun(s, i) {
  const n = s.length;
  let j = i + 1;
  if (s.charCodeAt(i) === 96) { // backtick: consume the whole run
    while (j < n && s.charCodeAt(j) === 96) j++;
  }
  while (j < n) {
    const c = s.charCodeAt(j);
    const k = c < 128 ? SCAN_KIND[c] : 0;
    if (k === 0) { j++; continue; }
    if (k === 1) return j; // \ < [ ` * _ ~
    if (k === 2) { // '!': stop only before '['
      if (s.charCodeAt(j + 1) === 91) return j;
      j++; continue;
    }
    if (k === 3) { // space: hard break only if a run of >=2 spaces + \n + non-ws follows
      if (s.charCodeAt(j - 1) === 32) { j++; continue; } // continuation of a run already evaluated
      let kk = j;
      while (kk < n && s.charCodeAt(kk) === 32) kk++;
      if (j > i && kk - j >= 2 && s.charCodeAt(kk) === 10) {
        NON_WS_GLOBAL.lastIndex = kk + 1; // br's (?!\s*$): some non-ws must follow the \n
        if (NON_WS_GLOBAL.exec(s)) return j;
      }
      j++; continue;
    }
    if (k === 4) { // '@': backpedal to the email local-part start
      let r = j - 1;
      while (r >= 0 && isEmailLocalCode(s.charCodeAt(r))) r--;
      r++;
      return r > i ? r : i + 1;
    }
    if (k === 5) { // w/W: www.
      if (s.charCodeAt(j + 1) === 119 && s.charCodeAt(j + 2) === 119 && s.charCodeAt(j + 3) === 46) {
        const pc = s.charCodeAt(j - 1);
        if (pc === 32 || pc === 9 || pc === 10 || pc === 13 || pc === 42 || pc === 95 || pc === 126 || pc === 40) return j;
      }
      j++; continue;
    }
    if (k === 6) { // m/M/x/X: mailto:/xmpp:
      if (s.startsWith('mailto:', j) || s.startsWith('xmpp:', j)) {
        if (!isAlnumCode(s.charCodeAt(j - 1))) return j;
      }
      j++; continue;
    }
    if (k === 7) { // h/H: http/https
      const c1 = s.charCodeAt(j + 1), c2 = s.charCodeAt(j + 2), c3 = s.charCodeAt(j + 3);
      if ((c1 === 116 || c1 === 84) && (c2 === 116 || c2 === 84) && (c3 === 112 || c3 === 80)) return j;
      j++; continue;
    }
    // k === 8: f/F: ftp
    const c1 = s.charCodeAt(j + 1), c2 = s.charCodeAt(j + 2);
    if ((c1 === 116 || c1 === 84) && (c2 === 112 || c2 === 80)) return j;
    j++;
  }
  return n;
}

/* =============== the inline parser =============== */

// Parse an inline string to HTML (plain=false) or to plain text (plain=true,
// the text-renderer used for image alt text). ctx carries refs + shared state.
function renderInline(s, ctx, plain) {
  if (!s) return '';
  if (!INLINE_TRIGGER.test(s)) return plain ? decodeNumericRefs(s) : escapeText(decodeNumericRefs(s));
  const savedParen = ctx.st.linkParenPossible;
  ctx.st.linkParenPossible = savedParen && s.includes(')');
  // The masked copy and closer table only feed emphasis/del, so they are
  // built only when the string can contain a delimiter (*, _ or ~).
  const hasEm = s.indexOf('*') !== -1 || s.indexOf('_') !== -1 || s.indexOf('~') !== -1;
  const masked = hasEm ? maskInline(s, ctx.refs) : s;
  const closers = hasEm ? lastCloserPositions(masked) : { star: -1, under: -1, tilde: -1 };
  const st = ctx.st;
  let out = '', i = 0, prevChar = '';
  try {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      let m, consumed = 0;
      if (c === 92) { // backslash: escape, else hard break
        inlineEscapeY.lastIndex = i;
        if ((m = inlineEscapeY.exec(s))) {
          out += plain ? m[1] : escapeText(m[1]);
          consumed = m[0].length;
        } else {
          hardBreakY.lastIndex = i;
          if ((m = hardBreakY.exec(s))) {
            out += plain ? '' : '<br>';
            consumed = m[0].length;
          }
        }
      } else if (c === 60) { // '<': raw html tag, else autolink
        inlineTagY.lastIndex = i;
        if ((m = inlineTagY.exec(s))) {
          if (!st.inLink && anchorOpenRe.test(m[0])) st.inLink = true;
          else if (st.inLink && anchorCloseRe.test(m[0])) st.inLink = false;
          if (!st.inRaw && preOpenRe.test(m[0])) st.inRaw = true;
          else if (st.inRaw && preCloseRe.test(m[0])) st.inRaw = false;
          out += m[0];
          consumed = m[0].length;
        } else {
          autolinkY.lastIndex = i;
          if ((m = autolinkY.exec(s))) {
            const isEmail = m[2] === '@';
            const text = m[1], href = isEmail ? 'mailto:' + m[1] : m[1];
            const r = buildLink(text, false, href, '', m[0], ctx, plain, true);
            out += r.out;
            consumed = m[0].length;
          }
        }
      } else if (c === 91 || c === 33) { // '[' or '!': inline link, then ref link
        if ((m = tryInlineLink(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        } else if ((m = tryReferenceLink(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        }
      } else if (c === 42 || c === 95) { // '*' '_': emphasis
        const em = tryEmphasis(s, masked, i, closers, prevChar);
        if (em) {
          const inner = renderInline(em.text, ctx, plain);
          out += plain ? inner : (em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
          consumed = em.raw.length;
        }
      } else if (c === 96) { // '`': code span
        codeSpanY.lastIndex = i;
        if ((m = codeSpanY.exec(s))) {
          let code = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(code) && /^ /.test(code) && / $/.test(code)) code = code.substring(1, code.length - 1);
          out += plain ? code : '<code>' + escapeAll(code) + '</code>';
          consumed = m[0].length;
        }
      } else if (c === 126) { // '~': strikethrough
        const del = tryStrikethrough(s, masked, i, closers, prevChar);
        if (del) {
          const inner = renderInline(del.text, ctx, plain);
          out += plain ? inner : '<del>' + inner + '</del>';
          consumed = del.raw.length;
        }
      } else if (c === 32) { // space: hard break
        hardBreakY.lastIndex = i;
        if ((m = hardBreakY.exec(s))) {
          out += plain ? '' : '<br>';
          consumed = m[0].length;
        }
      } else if (!st.inLink && isAlnumCode(c)) { // word char: extended autolink / email
        if ((m = tryExtendedUrl(s, i, ctx, plain))) {
          out += m.out;
          consumed = m.raw.length;
        }
      }
      if (!consumed) {
        // plain text run
        const end = scanTextRun(s, i);
        const raw = s.slice(i, end);
        if (st.inRaw) out += raw;
        else if (plain) out += decodeNumericRefs(raw);
        else out += escapeText(decodeNumericRefs(raw));
        const lastCh = raw.charCodeAt(raw.length - 1);
        if (lastCh !== 95) prevChar = raw.charAt(raw.length - 1); // not '_' -> update
        consumed = end - i;
        i += consumed;
        continue;
      }
      prevChar = '';
      i += consumed;
    }
  } finally {
    ctx.st.linkParenPossible = savedParen;
  }
  return out;
}

/* =============== block lexer =============== */

// Table cell splitter (marked's de()).
function splitTableCells(a, limit) {
  const t = a.replace(/\|/g, (m, o, str) => {
    let odd = false, p = o;
    while (--p >= 0 && str.charCodeAt(p) === 92) odd = !odd;
    return odd ? '|' : ' |';
  });
  const n = t.split(' |');
  if (!n[0].trim()) n.shift();
  if (n.length > 0 && !n[n.length - 1].trim()) n.pop();
  if (limit !== undefined) {
    if (n.length > limit) n.length = limit;
    else while (n.length < limit) n.push('');
  }
  for (let s = 0; s < n.length; s++) n[s] = n[s].trim().replace(/\\\|/g, '|');
  return n;
}

// Fenced-code indent compensation (marked's Dt()).
function dedentFence(full, content) {
  const m = FENCE_INDENT.exec(full);
  if (!m) return content;
  const ind = m[1].length;
  return content.split('\n').map(line => {
    const o = LEADING_SPACES.exec(line);
    if (!o) return line;
    return line.slice(Math.min(o[0].length, ind));
  }).join('\n');
}

// Cached per-indent block-start regexes. The indent clamps to
// n = max(0, min(3, R-1)): a marker at exactly the content indent is a
// nested construct (continuation), not a sibling break.
const _atRegexCache = new Map();
function indentRegexes(R) {
  const n = Math.max(0, Math.min(3, R - 1));
  let v = _atRegexCache.get(n);
  if (!v) {
    v = { next: nextBulletRe(n), hr: hrAtRe(n), fences: fencesAtRe(n), heading: headingAtRe(n), html: htmlAtRe(n), bq: bqAtRe(n) };
    _atRegexCache.set(n, v);
  }
  return v;
}

function lexList(e, ctx) {
  const t = listStartRe.exec(e);
  if (!t) return null;
  const n = e;
  let rest = e;
  const r = t[1].trim();
  const ordered = r.length > 1;
  const marker = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const itemRe = listItemRe(marker);
  const list = { type: 'list', ordered, start: ordered ? +r.slice(0, -1) : 0, loose: false, items: [], raw: '' };
  let p = false;
  while (rest.length > 0) {
    let u = false, d = '';
    const it = itemRe.exec(rest);
    if (!it || hrRe.test(rest)) break;
    const k = n.length - rest.length;
    rest = rest.slice(it[0].length);
    const g = it[2].split('\n', 1)[0];
    const b = it[1].length;
    let m = g.replace(LEADING_WS, v => expandTabs(v, b));
    let f = rest.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(NON_SPACE);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && BLANK_LINE.test(f)) {
      rest = rest.slice(f.length + 1);
      u = true;
    }
    if (!u) {
      const at = indentRegexes(R);
      // Index cursor over rest (no per-line rest.slice: that was O(n^2)).
      // Break tests are pre-filtered by the line's first non-space char:
      // the at-* regexes are all ^ {0,n} + a marker, so they can only match
      // when the first non-space char is one of ` ~ # < > * + - _ or a digit,
      // and never when a tab precedes it (^ {0,n} allows spaces only).
      let rp = 0;
      const dp = [d];
      while (rp < rest.length) {
        let nl = rest.indexOf('\n', rp);
        if (nl === -1) nl = rest.length;
        const U = rest.slice(rp, nl);
        f = U;
        let j = 0, hasTab = false;
        while (j < U.length) {
          const c = U.charCodeAt(j);
          if (c === 32) j++;
          else if (c === 9) { hasTab = true; j++; }
          else break;
        }
        const firstCh = j < U.length ? U.charCodeAt(j) : -1;
        let isBreak = false;
        if (!hasTab && firstCh !== -1) {
          if (firstCh === 96 || firstCh === 126) isBreak = at.fences.test(U);
          else if (firstCh === 35) isBreak = at.heading.test(U);
          else if (firstCh === 60) isBreak = at.html.test(U);
          else if (firstCh === 62) isBreak = at.bq.test(U);
          else if (firstCh === 42 || firstCh === 43 || firstCh === 45) isBreak = at.next.test(U) || at.hr.test(U);
          else if (firstCh === 95) isBreak = at.hr.test(U);
          else if (firstCh >= 48 && firstCh <= 57) isBreak = at.next.test(U);
        }
        if (isBreak) break;
        const Z = hasTab ? U.replace(LEADING_WS, me => expandTabs(me, 0)) : U;
        const nonSpace = hasTab ? Z.search(NON_SPACE) : j;
        if (nonSpace >= R || !U.trim()) dp.push('\n' + Z.slice(R));
        else {
          if (y || m.replace(/\t/g, '    ').search(NON_SPACE) >= 4 || at.fences.test(m) || at.heading.test(m) || at.html.test(m) || at.hr.test(m)) break;
          const qe = SETEXT_LINE.test(U) && setextHeadingRe.test(m + '\n' + U) ? '    ' + Z.replace(/^ {0,3}/, '') : U;
          dp.push('\n' + qe);
        }
        y = !U.trim();
        rp = nl + 1;
        m = Z.slice(R);
      }
      d = dp.join('');
      rest = rest.slice(Math.min(rp, rest.length));
    }
    const A = n.slice(k, n.length - rest.length);
    if (!list.loose) {
      if (p) list.loose = true;
      else if (DOUBLE_BLANK_END.test(A)) p = true;
    }
    list.items.push({ raw: A, task: TASK_ITEM.test(d), text: d, children: null, checkbox: undefined });
  }
  const last = list.items[list.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = n.slice(0, n.length - rest.length).trimEnd();
  for (const item of list.items) {
    const sub = lexBlocks(item.text, false, ctx);
    item.children = sub.nodes;
    if (!list.loose && sub.blankRun) list.loose = true;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const nd of item.children) if (nd.type === 'text') nd.type = 'para';
    }
  }
  for (const item of list.items) {
    if (!item.task) continue;
    const first = item.children[0];
    if (!first || (first.type !== 'text' && first.type !== 'para')) { item.task = false; continue; }
    item.text = item.text.replace(TASK_PREFIX, '');
    first.text = first.text.replace(TASK_PREFIX, '');
    const ck = TASK_CHECKBOX.exec(item.raw);
    if (ck) item.checkbox = ck[0] !== '[ ]';
  }
  return { node: list, rawLen: list.raw.length };
}

function lexBlockquote(e, ctx) {
  const t = blockquoteRe.exec(e);
  if (!t) return null;
  let lines = stripTrailingNewlines(t[0]).split('\n');
  let s = '', r = '';
  const nodes = [];
  while (lines.length > 0) {
    let started = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BQ_LINE_START.test(lines[p])) { chunk.push(lines[p]); started = true; }
      else if (!started) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(BQ_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
               .replace(BQ_SETEXT, '\n    $1')
               .replace(BQ_STRIP_MARKER, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    // Re-parse the chunk into the shared node list; the first paragraph of
    // each chunk merges into a preceding paragraph (lazy continuation).
    lexBlocks(u, true, ctx, true, nodes);
    if (lines.length === 0) break;
    const k = nodes[nodes.length - 1];
    if (k && (k.type === 'code' || k.type === 'head' || k.type === 'hr' || k.type === 'html' || k.type === 'table')) break;
    if (k && k.type === 'quote') {
      const b = lines.join('\n');
      const m2 = k.raw + '\n' + b.replace(BQ_STRIP_MARKER, '');
      const f = lexBlockquote(m2, ctx);
      if (!f) break;
      nodes[nodes.length - 1] = f.node;
      const y = m2.substring(f.rawLen).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - k.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && BQ_LINE_START.test(lines[0])) continue;
      break;
    } else if (k && k.type === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const m2 = lexList(b, ctx);
      if (!m2) break;
      nodes[nodes.length - 1] = m2.node;
      const f = m2.rawLen > k.raw.length ? b.slice(k.raw.length + 1, m2.rawLen).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: { type: 'quote', children: nodes, text: r, raw: s }, rawLen: s.length };
}

function lexTable(e, ctx) {
  const t = tableRe.exec(e);
  if (!t || !TABLE_HAS_DELIM.test(t[2])) return null;
  const headerCells = splitTableCells(t[1]);
  const delimCells = t[2].replace(TABLE_TRIM_PIPES, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const aligns = delimCells.map(c => TABLE_ALIGN_RIGHT.test(c) ? 'right' : TABLE_ALIGN_CENTER.test(c) ? 'center' : TABLE_ALIGN_LEFT.test(c) ? 'left' : null);
  const rows = t[3] && t[3].trim() ? t[3].replace(TABLE_TRAILING_BLANK, '').split('\n') : [];
  const header = headerCells.map((c, i) => ({ text: c, align: aligns[i] }));
  const body = rows.map(r => splitTableCells(r, headerCells.length).map((c, i) => ({ text: c, align: aligns[i] })));
  return { node: { type: 'table', head: header, rows: body }, rawLen: stripTrailingNewlines(t[0]).length };
}

// Block lexer. top: paragraphs are real paragraphs (else text nodes).
// mergePara: the first paragraph of this call merges into a preceding
// paragraph (blockquote lazy continuation; consumed after the first one).
// out: node list to append to (shared across blockquote chunks).
// Returns { nodes, blankRun } where blankRun means a >=2-newline run was seen.
function lexBlocks(src, top, ctx, mergePara, out) {
  const nodes = out || [];
  let rest = src;
  let blankRun = false;
  let blankGap = false; // a blank line (space token) has intervened since the last node
  let merge = !!mergePara;
  while (rest.length > 0) {
    const sp = newlineRe.exec(rest);
    if (sp) {
      const first = sp[0].indexOf('\n');
      if (first !== -1 && sp[0].indexOf('\n', first + 1) !== -1) blankRun = true;
      if (sp[0].length > 1) blankGap = true;
      rest = rest.slice(sp[0].length);
      continue;
    }
    let c0 = rest.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      let col = 0, i = 0;
      while (i < rest.length) {
        const c = rest.charCodeAt(i);
        if (c === 32) { col++; i++; }
        else if (c === 9) { col += 4 - (col % 4); i++; }
        else break;
      }
      if (col >= 4) {
        const cd = indentedCodeRe.exec(rest);
        if (cd) {
          const raw = trimHtmlBlock(cd[0]);
          const codeText = raw.replace(CODE_INDENT_STRIP, '');
          const prev = nodes[nodes.length - 1];
          if (!blankGap && prev && (prev.type === 'para' || prev.type === 'text')) {
            prev.text += '\n' + codeText; // indented code merges into a paragraph
          } else {
            nodes.push({ type: 'code', text: codeText, lang: '' });
          }
          blankGap = false;
          rest = rest.slice(raw.length);
          continue;
        }
      }
      c0 = i < rest.length ? rest.charCodeAt(i) : -1;
    }
    let node = null, consumed = 0;
    if (c0 === 96 || c0 === 126) { // ` ~
      const f = fencesRe.exec(rest);
      if (f) {
        const info = f[2] ? f[2].trim().replace(BACKSLASH_PUNCT, '$1') : '';
        const lang = info ? info.match(/^\S*/)[0] : '';
        node = { type: 'code', text: dedentFence(f[0], f[3] || ''), lang };
        consumed = f[0].length;
      }
    }
    if (!node && c0 === 35) { // #
      const h = atxHeadingRe.exec(rest);
      if (h) {
        let txt = h[2].trim();
        if (/#$/.test(txt)) {
          const s = trimTrailingChar(txt, 35);
          if (!s || /[ \t]$/.test(s)) txt = s.trim();
        }
        node = { type: 'head', depth: h[1].length, text: txt };
        consumed = stripTrailingNewlines(h[0]).length;
      }
    }
    if (!node && c0 === 62) { // >
      const b = lexBlockquote(rest, ctx);
      if (b) { node = b.node; consumed = b.rawLen; }
    }
    if (!node && (c0 === 45 || c0 === 43 || c0 === 42 || c0 === 95)) { // - + * _
      const hr = hrRe.exec(rest);
      if (hr) { node = { type: 'hr' }; consumed = stripTrailingNewlines(hr[0]).length; }
      else {
        const l = lexList(rest, ctx);
        if (l) { node = l.node; consumed = l.rawLen; }
      }
    }
    if (!node && c0 === 60) { // <
      const h = htmlBlockRe.exec(rest);
      if (h) {
        const raw = trimHtmlBlock(h[0]);
        node = { type: 'html', text: raw };
        consumed = raw.length;
      }
    }
    if (!node && c0 === 91) { // [
      const d = linkDefRe.exec(rest);
      if (d && (STARTS_WITH_ANGLE.test(d[2]) || parenBalance(d[2]) === -1)) {
        const defRaw = stripTrailingNewlines(d[0]);
        const prev = nodes[nodes.length - 1];
        if (!blankGap && prev && (prev.type === 'para' || prev.type === 'text')) {
          prev.text += '\n' + defRaw; // def merges into a directly-following paragraph
        } else {
          const tag = normalizeLabel(d[1]);
          if (!ctx.refs.has(tag)) {
            const href = d[2] ? d[2].replace(ANGLE_WRAPPED, '$1').replace(BACKSLASH_PUNCT, '$1') : '';
            const title = d[3] ? d[3].substring(1, d[3].length - 1).replace(BACKSLASH_PUNCT, '$1') : d[3];
            ctx.refs.set(tag, { href, title });
          }
          blankGap = true; // a registered def breaks the merge chain
        }
        rest = rest.slice(defRaw.length);
        continue;
      }
    }
    if (!node && c0 >= 48 && c0 <= 57) { // digit
      const l = lexList(rest, ctx);
      if (l) { node = l.node; consumed = l.rawLen; }
    }
    if (!node) {
      const tb = lexTable(rest, ctx);
      if (tb) { node = tb.node; consumed = tb.rawLen; }
    }
    if (!node) {
      const lh = setextHeadingRe.exec(rest);
      if (lh) {
        node = { type: 'head', depth: lh[2].charAt(0) === '=' ? 1 : 2, text: lh[1].trim() };
        consumed = stripTrailingNewlines(lh[0]).length;
      }
    }
    if (!node) {
      if (top) {
        const p = paragraphRe.exec(rest);
        if (p) {
          let txt = p[1];
          if (txt.charCodeAt(txt.length - 1) === 10) txt = txt.slice(0, -1);
          const prev = nodes[nodes.length - 1];
          if (merge && !blankGap && prev && prev.type === 'para') {
            prev.text += '\n' + txt; // lazy continuation across blockquote chunks
          } else {
            nodes.push({ type: 'para', text: txt });
          }
          merge = false;
          blankGap = false;
          rest = rest.slice(p[0].length);
          continue;
        }
      } else {
        const tx = textLineRe.exec(rest);
        if (tx) {
          const prev = nodes[nodes.length - 1];
          if (!blankGap && prev && prev.type === 'text') {
            prev.text += '\n' + tx[0]; // consecutive text lines merge
          } else {
            nodes.push({ type: 'text', text: tx[0] });
          }
          blankGap = false;
          rest = rest.slice(tx[0].length);
          continue;
        }
      }
    }
    if (!node) { rest = rest.slice(1); continue; } // safety: never spin
    nodes.push(node);
    blankGap = false;
    rest = rest.slice(consumed);
  }
  return { nodes, blankRun };
}

/* =============== renderer =============== */

// Inline-parse one block's text. inRaw resets per block (marked's queue loop);
// inLink / linkEmitted deliberately persist across blocks.
function inlineOf(t, ctx) {
  ctx.st.inRaw = false;
  return renderInline(t, ctx, false);
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderNode(nd, ctx, checkbox) {
  switch (nd.type) {
    case 'para': return '<p>' + (checkbox || '') + inlineOf(nd.text, ctx) + '</p>\n';
    case 'text': return inlineOf(nd.text, ctx);
    case 'head': return '<h' + nd.depth + '>' + inlineOf(nd.text, ctx) + '</h' + nd.depth + '>\n';
    case 'hr': return '<hr>\n';
    case 'code': {
      const r = nd.text ? nd.text.replace(/\n$/, '') + '\n' : '';
      return nd.lang
        ? '<pre><code class="language-' + escapeText(nd.lang) + '">' + escapeAll(r) + '</code></pre>\n'
        : '<pre><code>' + escapeAll(r) + '</code></pre>\n';
    }
    case 'html': return nd.text;
    case 'quote': return '<blockquote>\n' + renderBlockList(nd.children, ctx) + '</blockquote>\n';
    case 'list': {
      const tag = nd.ordered ? 'ol' : 'ul';
      const start = nd.ordered && nd.start !== 1 ? ' start="' + nd.start + '"' : '';
      let s = '<' + tag + start + '>\n';
      for (const it of nd.items) s += renderListItem(it, ctx);
      return s + '</' + tag + '>\n';
    }
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (const c of nd.head) s += renderTableCell(c, true, ctx);
      s += '</tr>\n</thead>\n';
      if (nd.rows.length > 0) {
        s += '<tbody>';
        for (const row of nd.rows) {
          s += '<tr>\n';
          for (const c of row) s += renderTableCell(c, false, ctx);
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      return s + '</table>\n';
    }
  }
  return '';
}

function renderTableCell(c, isHeader, ctx) {
  const tag = isHeader ? 'th' : 'td';
  return (c.align ? '<' + tag + ' align="' + c.align + '">' : '<' + tag + '>') + inlineOf(c.text, ctx) + '</' + tag + '>\n';
}

function renderListItem(item, ctx) {
  let s = '<li>';
  const nodes = item.children;
  if (item.checkbox !== undefined) {
    const cb = checkboxHtml(item.checkbox);
    if (item.loose && nodes.length > 0 && (nodes[0].type === 'para' || nodes[0].type === 'text')) {
      // loose list: checkbox goes inside the first paragraph
      s += renderNode(nodes[0], ctx, cb);
      for (let j = 1; j < nodes.length; j++) s += renderNode(nodes[j], ctx);
    } else if (item.loose) {
      // loose list, first block is not a paragraph: checkbox gets its own paragraph
      s += '<p>' + cb + '</p>\n';
      for (const nd of nodes) s += renderNode(nd, ctx);
    } else {
      // tight list: checkbox is a standalone token before the content
      s += cb;
      for (const nd of nodes) s += renderNode(nd, ctx);
    }
  } else {
    for (const nd of nodes) s += renderNode(nd, ctx);
  }
  return s + '</li>\n';
}

function renderBlockList(nodes, ctx) {
  let out = '';
  for (const nd of nodes) out += renderNode(nd, ctx);
  return out;
}

/* =============== public entry point =============== */

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = { refs: new Map(), st: { inLink: false, inRaw: false, linkEmitted: false, linkParenPossible: true } };
  const { nodes } = lexBlocks(src, true, ctx);
  return renderBlockList(nodes, ctx);
}
