// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Pure JavaScript, dependency-free, single file. Behaviour mirrors the reference
// (vendor/makefun-site) byte for byte; only the implementation is faster:
//   - Markdown: no per-line regexes, no token array, bulk plain-text escaping
//     (the reference escapes one character at a time), index-bounded inline scan.
//   - Templates: parsed once, compiled to flat ops, includes expanded at
//     compile time, frame-based scope resolution (no scope-chain walk).
//   - Text: ASCII fast paths for slugify / word counting with exact fallbacks,
//     slug memoisation.
//   - Front matter: index-based line scan, no whole-body split/join.

/* ------------------------------------------------------------------ text */

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  if (slugCache.size < 8192) slugCache.set(text, out);
  return out;
}
function slugifySlow(text) {
  // Fast path: pure ASCII needs no NFKD and has no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Words: runs of non-whitespace. Single scan; Unicode whitespace is the exact
// JS \s set, so no regex fallback is ever needed.
function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 ||
    c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF;
}
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // inline isWSCode (JS \s set) — avoids a call per char on the hot path.
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
        c === 0xA0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200A) || c === 0x2028 ||
        c === 0x2029 || c === 0x202F || c === 0x205F || c === 0x3000 || c === 0xFEFF) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

// Parse front matter without splitting the whole body: locate the closing '---'
// line, parse the few lines between, and slice the body out directly.
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  if (nl0 === -1) return { error: 'the front matter is not closed' };
  // Find the closing '---' line: scan line starts after the first line.
  let pos = nl0 + 1; // start of line 2 (line index 1)
  let close = -1;
  let closeEnd = -1;
  let lineNo = 1; // 0-based index of the line starting at pos
  while (pos <= text.length) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    if (line === '---') { close = lineNo; closeEnd = eol; break; }
    pos = eol + 1;
    lineNo++;
    if (eol === text.length) break;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-walk the front-matter lines (line indexes 1..close-1) parsing each.
  pos = text.indexOf('\n', 0) + 1;
  for (let i = 1; i < close; i++) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    pos = eol + 1;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // blank or '#...'
    // LINE = /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2).replace(/[ \t]+$/, '');
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/* --------------------------------------------------------------- markdown */

// Whitespace test matching JS \s for a single char code.
function isSpaceCh(c) {
  return isWSCode(c);
}
const WS_RE = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
// Actionable inline specials only (HTML-specials are handled by the bulk escape).
const SPECIAL = /[\\`*\[]/g;

function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Render s[start..end) inline into parts. Mirrors the reference's inline()
// exactly, but escapes plain runs in bulk instead of one character at a time.
function inlineInto(s, start, end, env, parts) {
  let plain = start;
  SPECIAL.lastIndex = start;
  for (;;) {
    const m = SPECIAL.exec(s);
    if (m === null || m.index >= end) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      const n = j + 1;
      if (n < end && ESCAPABLE.has(s[n])) {
        if (j > plain) parts.push(escapeHtml(s.slice(plain, j)));
        parts.push(escapeHtml(s[n]));
        plain = n + 1;
        SPECIAL.lastIndex = plain;
        continue;
      }
      SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === 96) { // backtick
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        if (j > plain) parts.push(escapeHtml(s.slice(plain, j)));
        parts.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        plain = k + 1;
        SPECIAL.lastIndex = plain;
        continue;
      }
      SPECIAL.lastIndex = j + 1;
      continue;
    }
    if (c === 42) { // '*'
      if (j + 1 < end && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, end);
        if (k !== -1 && k > j + 2) {
          if (j > plain) parts.push(escapeHtml(s.slice(plain, j)));
          parts.push('<strong>');
          inlineInto(s, j + 2, k, env, parts);
          parts.push('</strong>');
          plain = k + 2;
          SPECIAL.lastIndex = plain;
          continue;
        }
        SPECIAL.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, end);
      if (k !== -1 && k > j + 1) {
        if (j > plain) parts.push(escapeHtml(s.slice(plain, j)));
        parts.push('<em>');
        inlineInto(s, j + 1, k, env, parts);
        parts.push('</em>');
        plain = k + 1;
        SPECIAL.lastIndex = plain;
        continue;
      }
      SPECIAL.lastIndex = j + 1;
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', j + 1, end);
    let mm = -1;
    if (k !== -1 && k + 1 < end && s.charCodeAt(k + 1) === 40) mm = s.indexOf(')', k + 2);
    if (mm !== -1 && mm < end) {
      const target = s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (j > plain) parts.push(escapeHtml(s.slice(plain, j)));
        parts.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineInto(s, j + 1, k, env, parts);
        parts.push('</a>');
        plain = mm + 1;
        SPECIAL.lastIndex = plain;
        continue;
      }
    }
    SPECIAL.lastIndex = j + 1;
  }
  if (end > plain) parts.push(escapeHtml(s.slice(plain, end)));
}

// Trim spaces/tabs at both ends (the reference's trimLine).
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isFenceOpen(line) {
  // /^```([A-Za-z0-9_+-]*)[ \t]*$/
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return -1;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? langEnd : -1;
}

function isFenceClose(line) {
  // /^```[ \t]*$/
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function headingOf(line) {
  // /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with non-empty text.
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  // /^(?:---|\*\*\*)[ \t]*$/
  if (line.length < 3) return false;
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlankLine(line) || isFenceOpen(line) !== -1 || headingOf(line) !== null || isHr(line);
}

// Render one body's Markdown: { html, toc, excerpt }. Fused lex+render, no token array.
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  const parts = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const fenceLang = isFenceOpen(line);
    if (fenceLang !== -1) {
      const lang = line.slice(3, fenceLang);
      parts.push('<pre><code');
      if (lang !== '') { parts.push(' class="language-', escapeHtml(lang), '"'); }
      parts.push('>');
      i++;
      while (i < n && !isFenceClose(lines[i])) { parts.push(escapeHtml(lines[i]), '\n'); i++; }
      i++;
      parts.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      if (heading.depth === 2 || heading.depth === 3) {
        const hp = [];
        inlineInto(heading.text, 0, heading.text.length, env, hp);
        const html = hp.join('');
        parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        toc.push({ level: heading.depth, id, html });
      } else {
        parts.push(`<h${heading.depth} id="${id}">`);
        inlineInto(heading.text, 0, heading.text.length, env, parts);
        parts.push(`</h${heading.depth}>\n`);
      }
      i++;
      continue;
    }
    if (isHr(line)) { parts.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const text = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(text, 0, text.length, env, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    // List: bullet '- ' / '* ' or ordered 'digits. '
    let isOrdered = false;
    let startNum = 1;
    let itemText = null;
    {
      const c0 = line.charCodeAt(0);
      if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
        itemText = line.slice(2);
      } else if (c0 >= 48 && c0 <= 57) {
        let d = 0;
        while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
        if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
          isOrdered = true;
          startNum = Number(line.slice(0, d));
          itemText = line.slice(d + 2);
        }
      }
    }
    if (itemText !== null) {
      const items = [[trimLine(itemText)]];
      i++;
      const markerBullet = !isOrdered;
      while (i < n) {
        const l = lines[i];
        let mText = null;
        let mOrdered = false;
        let mNum = 1;
        const c0 = l.charCodeAt(0);
        if (markerBullet) {
          if ((c0 === 45 || c0 === 42) && l.charCodeAt(1) === 32) mText = l.slice(2);
        } else if (c0 >= 48 && c0 <= 57) {
          let d = 0;
          while (d < l.length && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d >= 1 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) { mOrdered = true; mNum = Number(l.slice(0, d)); mText = l.slice(d + 2); }
        }
        if (mText !== null) {
          items.push([trimLine(mText)]);
          i++;
        } else if (l.length >= 2 && l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          // CONTINUED: /^ {2,}\S/ — 2+ spaces then a non-space char.
          let s = 0;
          while (s < l.length && l.charCodeAt(s) === 32) s++;
          if (s >= 2 && s < l.length && !isSpaceCh(l.charCodeAt(s))) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && startNum !== 1 ? `<ol start="${startNum}">\n` : `<${tag}>\n`);
      for (const itemParts of items) {
        const text = itemParts.join('\n');
        parts.push('<li>');
        inlineInto(text, 0, text.length, env, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: lines until blank / fence / heading / hr.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const pp = [];
      inlineInto(text, 0, text.length, env, pp);
      const html = pp.join('');
      excerpt = html;
      parts.push('<p>', html, '</p>\n');
    } else {
      parts.push('<p>');
      inlineInto(text, 0, text.length, env, parts);
      parts.push('</p>\n');
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Compile a parsed node tree to flat ops, expanding includes at compile time.
// Op forms: [0, text] | [1, pathKeys, isRaw] | [2, pathKeys, not, thenOps, elseOps|null]
//           | [3, pathKeys, loopName, bodyOps]
function compileNodes(nodes, templates, depth, memo) {
  const ops = [];
  for (const n of nodes) {
    if (n.kind === 'text') ops.push([0, n.text]);
    else if (n.kind === 'var' || n.kind === 'raw') ops.push([1, n.path, n.kind === 'raw']);
    else if (n.kind === 'if') {
      ops.push([2, n.path, n.not, compileNodes(n.then, templates, depth, memo), n.else === null ? null : compileNodes(n.else, templates, depth, memo)]);
    } else if (n.kind === 'for') {
      ops.push([3, n.path, n.name, compileNodes(n.body, templates, depth, memo)]);
    } else if (n.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(n.name);
        if (t !== undefined) {
          const key = `${n.name}|${depth + 1}`;
          let sub = memo.get(key);
          if (sub === undefined) {
            sub = compileNodes(t, templates, depth + 1, memo);
            memo.set(key, sub);
          }
          for (const o of sub) ops.push(o);
        }
      }
    }
  }
  return ops;
}

function lookup(root, frame, path) {
  const first = path[0];
  let v;
  if (first === 'loop') {
    // Every for-scope binds 'loop' (a loop variable named 'loop' is shadowed by
    // it in the reference's vars object, so the innermost loop object wins).
    if (frame.length === 0) return undefined;
    v = frame[frame.length - 1][2];
  } else {
    v = root[first];
    for (let f = frame.length - 1; f >= 0; f--) {
      if (frame[f][0] === first) { v = frame[f][1]; break; }
    }
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderOps(ops, root, frame, parts) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const k = op[0];
    if (k === 0) parts.push(op[1]);
    else if (k === 1) {
      const v = lookup(root, frame, op[1]);
      if (typeof v === 'number' || typeof v === 'boolean') {
        // numbers/booleans stringify to [0-9.eE+-] / true/false: never an HTML char.
        parts.push(String(v));
      } else {
        const s = textOf(v);
        parts.push(op[2] ? s : escapeHtml(s));
      }
    } else if (k === 2) {
      const branch = truthy(lookup(root, frame, op[1])) !== op[2] ? op[3] : op[4];
      if (branch !== null) renderOps(branch, root, frame, parts);
    } else {
      const xs = lookup(root, frame, op[1]);
      if (Array.isArray(xs)) {
        const body = op[3];
        const name = op[2];
        const len = xs.length;
        // One loop object per for-op, mutated per iteration: no render retains it
        // past its own iteration, and a for-op never runs concurrently with itself.
        let loop = op[4];
        if (loop === undefined) { loop = { index: 0, first: false, last: false, length: 0 }; op[4] = loop; }
        loop.length = len;
        for (let idx = 0; idx < len; idx++) {
          loop.index = idx + 1;
          loop.first = idx === 0;
          loop.last = idx === len - 1;
          frame.push([name, xs[idx], loop]);
          renderOps(body, root, frame, parts);
          frame.pop();
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- pipeline */

const RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  const card = s.card !== undefined ? s.card : (s.card = cardOf(s));
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer !== undefined ? s.newer : null),
    older: linkOf(s.older !== undefined ? s.older : null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  // 1. Templates, parsed in code-unit order of name; failures reported, left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile every parsed template to ops (includes expanded), shared memo.
  const memo = new Map();
  const compiled = new Map();
  for (const [name, tree] of templates) compiled.set(name, compileNodes(tree, templates, 0, memo));

  const base = input.site.base_url.replace(/\/+$/, '');

  // 2. Sources in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 3. Front matter + the drop checks, in order; the first failure is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 4. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 5. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 6. Collections: posts newest first, equal dates by slug; newer/older links.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 7. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 8. Layouts.
  const output = Object.create(null);
  for (const p of posts) p.card = cardOf(p);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  // One root scope object per case, reused across renders: the per-render vars
  // are cleared and re-set each time (a var absent from this render is undefined,
  // exactly as the reference's fresh vars object).
  const root = Object.create(null);
  root.site = site;
  root.tags = allTags;
  root.recent = recent;
  const render = (name, vars) => {
    const ops = compiled.get(name);
    if (ops === undefined) return null;
    root.page = undefined;
    root.posts = undefined;
    root.pager = undefined;
    root.tag = undefined;
    for (const k of Object.keys(vars)) root[k] = vars[k];
    const parts = [];
    renderOps(ops, root, [], parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 9. Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
