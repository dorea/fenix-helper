/**
 * fenix 语句解析（mini-DOM）+ SQL 渲染器 —— 纯函数，无 vscode 依赖。
 *
 * 渲染管线忠实复刻 fenix v2.7.0：
 *  1. 逐节点拼接：文本原样；条件标签按 tagHandlerMap 的 prefix/symbol 生成 `field OP :name`；
 *     value 表达式求值入 params（fixDot 后的名为命名参数）。
 *  2. FenixXmlBuilder.renderSqlAndOtherParams：
 *     a) 整段过 MVEL 模板（@if/@elseif/@else/@end、@{}）
 *     b) replaceBlank：去掉 | \t \r \n，多空格压一，trim
 *     c) `#{xxx}` → `:fixDot(xxx)` 且求值入 params
 *     d) 修剪 ` WHERE AND | WHERE OR | WHERE ORDER BY | WHERE GROUP BY`，去尾 WHERE
 */

import { evalCondition, evalExpr, parseExpr, renderTemplate, TemplateTrace } from './fenixExpr';
import { TAG_BY_NAME } from './xsdData';

// ---------- mini-DOM ----------

export interface RAttr {
  name: string;
  value: string;
  /** 属性值在全文中的绝对起点 */
  valueStart: number;
}

export interface RNode {
  kind: 'node';
  tag: string;
  attrs: RAttr[];
  children: RChild[];
  /** 标签 '<' 在全文中的绝对 offset */
  start: number;
  end: number;
  selfClosing: boolean;
}

export interface RText {
  kind: 'text';
  /** 反转义后的文本（用于渲染，与 dom4j 行为一致） */
  text: string;
  /** 原文切片（未反转义），其下标与文档 offset 一一对应，诊断定位必须用它 */
  raw: string;
  start: number;
  end: number;
}

export type RChild = RNode | RText;

export interface StmtNode {
  id: string;
  resultType?: string;
  node: RNode;
  start: number;
}

export interface FenixDoc {
  namespace?: string;
  statements: StmtNode[];
}

const TAG_RE = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/;

/** 扫描 XML 注释区间（<!-- ... -->，不可嵌套） */
export function commentRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while ((i = text.indexOf('<!--', i)) >= 0) {
    const e = text.indexOf('-->', i + 4);
    const end = e >= 0 ? e + 3 : text.length;
    ranges.push([i, end]);
    i = end;
  }
  return ranges;
}

export function inRanges(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) {
      return true;
    }
  }
  return false;
}

export function parseFenixDocument(text: string): FenixDoc {
  const doc: FenixDoc = { statements: [] };
  const comments = commentRanges(text);
  const rootTag = /<fenixs\b[^>]*?>/.exec(text);
  if (rootTag && !inRanges(rootTag.index, comments)) {
    const ns = /namespace\s*=\s*"([^"]*)"/.exec(rootTag[0]);
    if (ns) {
      doc.namespace = ns[1];
    }
  }
  const fenixRe = /<fenix(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = fenixRe.exec(text)) !== null) {
    // 跳过被注释掉的 fenix 语句（常见做法：老语句注释保留）
    const hit = comments.find(([s, e]) => m!.index >= s && m!.index < e);
    if (hit) {
      fenixRe.lastIndex = hit[1];
      continue;
    }
    const parsed = parseNodeAt(text, m.index);
    if (parsed) {
      const idAttr = parsed.node.attrs.find((a) => a.name === 'id');
      if (idAttr && parsed.node.tag === 'fenix') {
        const rt = parsed.node.attrs.find((a) => a.name === 'resultType');
        doc.statements.push({ id: idAttr.value, resultType: rt?.value, node: parsed.node, start: m.index });
      }
      fenixRe.lastIndex = parsed.end;
    }
  }
  return doc;
}

/** 从 offset 处解析一个元素节点（含子节点），返回结束 offset */
function parseNodeAt(text: string, offset: number): { node: RNode; end: number } | null {
  const re = new RegExp(TAG_RE.source, 'y');
  re.lastIndex = offset;
  const m = re.exec(text);
  if (!m) {
    return null;
  }
  const [, closeSlash, name, attrStr, selfClose] = m;
  if (closeSlash) {
    return null; // 起点不该是闭标签
  }
  const attrs = parseAttrs(attrStr, offset + 1 + name.length);
  const endOfOpen = offset + m[0].length;
  const node: RNode = {
    kind: 'node',
    tag: name,
    attrs,
    children: [],
    start: offset,
    end: endOfOpen,
    selfClosing: selfClose === '/',
  };
  if (node.selfClosing) {
    node.end = endOfOpen;
    return { node, end: endOfOpen };
  }
  // 解析子节点直到匹配闭标签
  let i = endOfOpen;
  for (;;) {
    const nextLt = text.indexOf('<', i);
    if (nextLt < 0) {
      node.end = text.length;
      return { node, end: text.length };
    }
    if (nextLt > i) {
      const rawText = text.slice(i, nextLt);
      node.children.push({
        kind: 'text',
        text: unescapeXml(rawText),
        raw: rawText,
        start: i,
        end: nextLt,
      });
    }
    // 注释 / CDATA / PI：dom4j 不会把它们当 Text/Element 子节点参与拼接
    if (text.startsWith('<!--', nextLt)) {
      const ce = text.indexOf('-->', nextLt + 4);
      i = ce >= 0 ? ce + 3 : text.length;
      continue;
    }
    if (text.startsWith('<![CDATA[', nextLt)) {
      const ce = text.indexOf(']]>', nextLt + 9);
      const end = ce >= 0 ? ce + 3 : text.length;
      node.children.push({
        kind: 'text',
        text: text.slice(nextLt + 9, ce >= 0 ? ce : text.length),
        raw: text.slice(nextLt + 9, ce >= 0 ? ce : text.length),
        start: nextLt,
        end,
      });
      i = end;
      continue;
    }
    if (text.startsWith('<?', nextLt)) {
      const ce = text.indexOf('?>', nextLt + 2);
      i = ce >= 0 ? ce + 2 : text.length;
      continue;
    }
    const closeRe = new RegExp(TAG_RE.source, 'y');
    closeRe.lastIndex = nextLt;
    const tm = closeRe.exec(text);
    if (!tm) {
      // 非法标签，跳过这个 '<'
      i = nextLt + 1;
      continue;
    }
    const [, cs, cname] = tm;
    if (cs === '/') {
      if (cname === name) {
        node.end = nextLt + tm[0].length;
        return { node, end: node.end };
      }
      // 其他闭标签：忽略
      i = nextLt + tm[0].length;
      continue;
    }
    const child = parseNodeAt(text, nextLt);
    if (child) {
      node.children.push(child.node);
      i = child.end;
    } else {
      i = nextLt + tm[0].length;
    }
  }
}

function parseAttrs(attrStr: string, base: number): RAttr[] {
  const attrs: RAttr[] = [];
  const re = /\s+([\w:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    const hasValue = m[2] !== undefined;
    const value = hasValue ? (m[3] !== undefined ? m[3] : m[4] ?? '') : '';
    let valueStart = base + m.index + m[0].length;
    if (hasValue) {
      const quote = m[0].includes('"' + value + '"') ? '"' : "'";
      const rel = m[0].indexOf(quote + value + quote);
      if (rel >= 0) {
        valueStart = base + m.index + rel + 1;
      }
    }
    attrs.push({ name: m[1], value: unescapeXml(value), valueStart });
  }
  return attrs;
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(node: RNode, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}

// ---------- 标签元数据（复刻 v2.7.0 tagHandlerMap 注册表） ----------

type Kind =
  | 'normal' | 'like' | 'startsWith' | 'endsWith' | 'in' | 'between' | 'null'
  | 'text' | 'import' | 'choose' | 'set' | 'where' | 'trimWhere';

export interface TagMeta {
  kind: Kind;
  prefix: string; // ' ' | ' AND ' | ' OR '
  symbol?: string; // ' = ' | ' <> ' | ...
}

const SYM = {
  eq: ' = ', ne: ' <> ', gt: ' > ', lt: ' < ', gte: ' >= ', lte: ' <= ',
  like: ' LIKE ', notLike: ' NOT LIKE ', in: ' IN ', notIn: ' NOT IN ',
  isNull: ' IS NULL ', isNotNull: ' IS NOT NULL ',
} as const;

function buildTagMeta(): Map<string, TagMeta> {
  const map = new Map<string, TagMeta>();
  const PREFIXES: Array<[string, string]> = [['', ' '], ['and', ' AND '], ['or', ' OR ']];

  // 1. normal 族：plain / and / or × 操作符
  const NORMAL_SYMS: Array<[string, string]> = [
    ['Equal', SYM.eq], ['NotEqual', SYM.ne],
    ['GreaterThan', SYM.gt], ['LessThan', SYM.lt],
    ['GreaterThanEqual', SYM.gte], ['LessThanEqual', SYM.lte],
  ];
  for (const [pfx, prefix] of PREFIXES) {
    for (const [suf, symbol] of NORMAL_SYMS) {
      // 无前缀时为小驼峰官方标签名（equal/notEqual/…），有前缀时 andEqual/orEqual
      const tag = pfx === '' ? suf[0].toLowerCase() + suf.slice(1) : pfx + suf;
      map.set(tag, { kind: 'normal', prefix, symbol });
    }
  }

  // 2. like 族：like / notLike / startsWith / notStartsWith / endsWith / notEndsWith
  const LIKE_KIND: Record<string, 'like' | 'startsWith' | 'endsWith'> = {
    like: 'like', startsWith: 'startsWith', endsWith: 'endsWith',
  };
  for (const [pfx, prefix] of PREFIXES) {
    for (const base of ['like', 'startsWith', 'endsWith']) {
      for (const not of ['', 'not']) {
        const core = not + base;
        // 无前缀：like / notLike / startsWith…（小驼峰）；有前缀：andLike / andNotLike…
        const tag = pfx === '' ? core : pfx + core[0].toUpperCase() + core.slice(1);
        const symbol = not === 'not' ? SYM.notLike : SYM.like;
        map.set(tag, { kind: LIKE_KIND[base], prefix, symbol });
      }
    }
  }

  // 3. in / notIn 族
  for (const [pfx, prefix] of PREFIXES) {
    map.set(pfx === '' ? 'in' : pfx + 'In', { kind: 'in', prefix, symbol: SYM.in });
    map.set(pfx === '' ? 'notIn' : pfx + 'NotIn', { kind: 'in', prefix, symbol: SYM.notIn });
  }

  // 4. between 族
  for (const [pfx, prefix] of PREFIXES) {
    map.set(pfx === '' ? 'between' : pfx + 'Between', { kind: 'between', prefix });
  }

  // 5. null 族
  for (const [pfx, prefix] of PREFIXES) {
    map.set(pfx === '' ? 'isNull' : pfx + 'IsNull', { kind: 'null', prefix, symbol: SYM.isNull });
    map.set(pfx === '' ? 'isNotNull' : pfx + 'IsNotNull', { kind: 'null', prefix, symbol: SYM.isNotNull });
  }

  // 6. 单例标签
  map.set('text', { kind: 'text', prefix: ' ' });
  map.set('import', { kind: 'import', prefix: ' ' });
  map.set('choose', { kind: 'choose', prefix: ' ' });
  map.set('set', { kind: 'set', prefix: ' ' });
  map.set('where', { kind: 'where', prefix: ' ' });
  map.set('trimWhere', { kind: 'trimWhere', prefix: ' ' });
  return map;
}

export const TAG_META = buildTagMeta();
export const KNOWN_TAGS = new Set<string>([...TAG_META.keys(), 'fenix', 'fenixs', ...TAG_BY_NAME.keys()]);

// ---------- 渲染 ----------

export interface RenderBranch {
  label: string;
  cond?: string;
  included: boolean;
  note?: string;
}

export interface RenderResult {
  sql: string;
  params: Array<{ name: string; value: unknown }>;
  branches: RenderBranch[];
  warnings: string[];
}

export interface RenderDeps {
  /** <import> 的目标节点解析器 */
  resolveImport?: (namespace: string, fenixId: string) => RNode | null;
  currentNamespace?: string;
  /**
   * 条件覆盖（预览面板的勾选框）：
   *   key = `tag@<节点起始 offset>` 或 `if:<条件表达式>`
   *   true = 强制包含该条件，false = 强制排除
   */
  overrides?: Map<string, boolean>;
}

/** 读取条件覆盖；未设置返回 undefined（走正常表达式求值） */
function overrideOf(deps: RenderDeps, key: string): boolean | undefined {
  return deps.overrides?.get(key);
}

class SqlState {
  join: string[] = [];
  params = new Map<string, unknown>();
  branches: RenderBranch[] = [];
  warnings: string[] = [];
  prependWhere = false;
  /** 当前 import 路径栈（检测真循环引用） */
  importStack: string[] = [];
}

/** 同时判断 null 与 undefined（避免宽松 == null） */
export function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

export function fixDot(t: string): string {
  return t.includes('.') ? t.split('.').join('_') : t;
}

export function renderStatement(stmtNode: RNode, ctx: Record<string, unknown>, deps: RenderDeps = {}): RenderResult {
  const st = new SqlState();
  st.importStack.push(`${deps.currentNamespace ?? ''}#${attr(stmtNode, 'id') ?? ''}`);
  processChildren(st, stmtNode.children, ctx, deps);
  return finishRender(st, ctx, deps);
}

function processChildren(st: SqlState, children: RChild[], ctx: Record<string, unknown>, deps: RenderDeps): void {
  for (const c of children) {
    if (c.kind === 'text') {
      appendText(st, c.text);
    } else {
      processTag(st, c, ctx, deps);
    }
  }
}

function appendText(st: SqlState, raw: string): void {
  // FenixContext.buildPlainTextSqlInfo 的忠实复刻
  if (st.prependWhere) {
    const text = replaceBlank(raw);
    if (text.trim() === '') {
      return;
    }
    st.join.push(' WHERE ');
    st.prependWhere = false;
    const lower = text.toUpperCase();
    if (lower.startsWith('AND ')) {
      st.join.push(text.slice(4));
    } else if (lower.startsWith('OR ')) {
      st.join.push(text.slice(3));
    } else {
      st.join.push(text);
    }
    st.join.push(' ');
    return;
  }
  st.join.push(raw);
}

function doPrependWhere(st: SqlState, prefixRef: { prefix: string }): void {
  if (st.prependWhere) {
    st.join.push(' WHERE ');
    if (prefixRef.prefix.trim().toUpperCase() === 'AND' || prefixRef.prefix.trim().toUpperCase() === 'OR') {
      prefixRef.prefix = '';
    }
    st.prependWhere = false;
  }
}

function evalValue(st: SqlState, expr: string, ctx: Record<string, unknown>): unknown {
  const ast = parseExpr(expr);
  if ('error' in ast) {
    st.warnings.push(`表达式解析失败：${expr}（${ast.error}）`);
    return undefined;
  }
  return evalExpr(ast, ctx);
}

function tagLabel(node: RNode): string {
  const field = attr(node, 'field');
  return `<${node.tag}${field ? ` field="${field}"` : ''}…>`;
}

function processTag(st: SqlState, node: RNode, ctx: Record<string, unknown>, deps: RenderDeps): void {
  const meta = TAG_META.get(node.tag);
  if (!meta) {
    st.warnings.push(`未注册的 fenix 标签：<${node.tag}>`);
    st.branches.push({ label: tagLabel(node), included: false, note: '未知标签（fenix 运行时会抛 NodeNotFoundException）' });
    return;
  }
  const matchCond = attr(node, 'match');
  // 勾选框可强制包含/排除（覆盖 match 求值结果）
  const forced = overrideOf(deps, `tag@${node.start}`);
  const matchOk = forced !== undefined ? forced : evalCondition(matchCond, ctx);

  switch (meta.kind) {
    case 'normal':
    case 'like':
    case 'startsWith':
    case 'endsWith':
    case 'in':
    case 'null': {
      if (!matchOk) {
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: false });
        return;
      }
      const field = attr(node, 'field');
      if (!field) {
        st.warnings.push(`<${node.tag}> 缺少必需属性 field`);
        return;
      }
      const pr = { prefix: meta.prefix };
      doPrependWhere(st, pr);
      if (meta.kind === 'null') {
        st.join.push(pr.prefix, field, meta.symbol ?? ' IS NULL ');
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: true });
        return;
      }
      const valueText = attr(node, 'value');
      const nameAttr = attr(node, 'name');
      const pattern = attr(node, 'pattern');
      if (meta.kind === 'like' && (!valueText || valueText.trim() === '') && pattern && pattern.trim() !== '') {
        // pattern 形式：field LIKE 'pattern'
        st.join.push(pr.prefix, field, meta.symbol ?? ' LIKE ', "'", pattern, "'");
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: true });
        return;
      }
      if (!valueText || valueText.trim() === '') {
        st.warnings.push(`<${node.tag}> 缺少必需属性 value`);
        return;
      }
      if (meta.kind === 'in') {
        const obj = evalValue(st, valueText, ctx);
        if (obj === null || obj === undefined) {
          st.branches.push({ label: tagLabel(node), cond: matchCond, included: false, note: 'value 求值为 null，跳过' });
          return;
        }
        const name = nameAttr && nameAttr.trim() !== '' ? nameAttr : fixDot(valueText);
        st.join.push(pr.prefix, field, meta.symbol ?? ' IN ', ':', name);
        st.params.set(name, obj);
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: true });
        return;
      }
      // normal / like / startsWith / endsWith 的 value 形式
      const value = evalValue(st, valueText, ctx);
      const name = nameAttr && nameAttr.trim() !== '' ? nameAttr : fixDot(valueText);
      let paramValue = value;
      if (meta.kind === 'like') {
        paramValue = `%${value ?? ''}%`;
      } else if (meta.kind === 'startsWith') {
        paramValue = `${value ?? ''}%`;
      } else if (meta.kind === 'endsWith') {
        paramValue = `%${value ?? ''}`;
      }
      st.join.push(pr.prefix, field, meta.symbol ?? ' = ', ':', name);
      st.params.set(name, paramValue);
      st.branches.push({ label: tagLabel(node), cond: matchCond, included: true });
      return;
    }
    case 'between': {
      const pr = { prefix: meta.prefix };
      if (!matchOk) {
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: false });
        return;
      }
      const field = attr(node, 'field');
      const startText = attr(node, 'start');
      const endText = attr(node, 'end');
      if (!field || startText === undefined || endText === undefined) {
        st.warnings.push(`<${node.tag}> 缺少 field/start/end 属性`);
        return;
      }
      const startValue = startText.trim() === '' ? null : evalValue(st, startText, ctx);
      const endValue = endText.trim() === '' ? null : evalValue(st, endText, ctx);
      if (isNil(startValue) && isNil(endValue)) {
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: false, note: 'start/end 均为 null，跳过' });
        return;
      }
      doPrependWhere(st, pr);
      const startName = attr(node, 'startName') || fixDot(startText);
      const endName = attr(node, 'endName') || fixDot(endText);
      if (!isNil(startValue) && isNil(endValue)) {
        st.join.push(pr.prefix, field, ' >= ', ':', startName);
        st.params.set(startName, startValue);
      } else if (isNil(startValue)) {
        st.join.push(pr.prefix, field, ' <= ', ':', endName);
        st.params.set(endName, endValue);
      } else {
        st.join.push(pr.prefix, field, ' BETWEEN ', ':', startName, ' AND ', ':', endName);
        st.params.set(startName, startValue);
        st.params.set(endName, endValue);
      }
      st.branches.push({ label: tagLabel(node), cond: matchCond, included: true });
      return;
    }
    case 'choose': {
      let i = 0;
      for (;;) {
        i++;
        // 与 fenix v2.7.0 ChooseHandler 一致：i=1 → "when"，i=2 → "when2"（when1 不被读取）
        const x = i === 1 ? '' : String(i);
        const whenText = attr(node, 'when' + x);
        if (whenText === undefined || whenText.trim() === '') {
          break;
        }
        const hit = evalCondition(whenText, ctx);
        st.branches.push({ label: `<choose when${x}>`, cond: whenText, included: hit });
        if (hit) {
          const thenText = attr(node, 'then' + x);
          if (thenText === undefined || thenText.trim() === '') {
            st.warnings.push(`<choose> when${x} 命中但 then${x} 为空`);
          } else {
            st.join.push(renderTemplate(thenText, ctx).out);
          }
          return;
        }
      }
      const elseText = attr(node, 'else');
      if (elseText && elseText.trim() !== '') {
        st.join.push(renderTemplate(elseText, ctx).out);
        st.branches.push({ label: '<choose else>', included: true });
      } else {
        st.branches.push({ label: '<choose>', included: false, note: '无命中分支且无 else' });
      }
      return;
    }
    case 'set': {
      let i = 0;
      let isSet = false;
      for (;;) {
        i++;
        // 与 fenix v2.7.0 SetHandler 一致：i=1 → "field"，i=2 → "field2"
        const x = i === 1 ? '' : String(i);
        const fieldText = attr(node, 'field' + x);
        if (fieldText === undefined || fieldText.trim() === '') {
          break;
        }
        const matchN = attr(node, 'match' + x);
        if (!evalCondition(matchN, ctx)) {
          st.branches.push({ label: `<set field${x}="${fieldText}">`, cond: matchN, included: false });
          continue;
        }
        st.branches.push({ label: `<set field${x}="${fieldText}">`, cond: matchN, included: true });
        if (!isSet) {
          st.join.push(' SET ');
          isSet = true;
        } else {
          st.join.push(', ');
        }
        const valueText = attr(node, 'value' + x);
        st.join.push(fieldText, ' = ', ':', fieldText);
        st.params.set(fieldText, valueText ? evalValue(st, valueText, ctx) : null);
      }
      return;
    }
    case 'text': {
      if (!matchOk) {
        st.branches.push({ label: '<text>', cond: matchCond, included: false });
        return;
      }
      for (const c of node.children) {
        if (c.kind === 'text') {
          appendText(st, c.text);
        } else {
          st.warnings.push('<text> 内只能包含文本');
        }
      }
      const valueAttr = attr(node, 'value');
      if (valueAttr && valueAttr.trim() !== '') {
        const v = evalValue(st, valueAttr, ctx);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            st.params.set(k, val);
          }
        }
      }
      st.branches.push({ label: '<text>', cond: matchCond, included: true });
      return;
    }
    case 'where':
    case 'trimWhere': {
      st.prependWhere = true;
      processChildren(st, node.children, ctx, deps);
      st.prependWhere = false;
      return;
    }
    case 'import': {
      if (!matchOk) {
        st.branches.push({ label: tagLabel(node), cond: matchCond, included: false });
        return;
      }
      const ns = attr(node, 'namespace') || deps.currentNamespace || '';
      const fenixId = attr(node, 'fenixId');
      if (!fenixId) {
        st.warnings.push('<import> 缺少 fenixId');
        return;
      }
      const key = `${ns}#${fenixId}`;
      // 用「当前 import 路径栈」检测真环，而不是全局已访问集合：
      // 同一片段被引用多次是合法的（如两个 UNION 分支），不能被误判为循环引用。
      if (st.importStack.includes(key)) {
        st.warnings.push(`<import> 循环引用：${[...st.importStack, key].join(' → ')}`);
        return;
      }
      const target = deps.resolveImport?.(ns, fenixId) ?? null;
      if (!target) {
        st.warnings.push(`<import> 找不到目标：${ns}#${fenixId}`);
        return;
      }
      st.branches.push({ label: tagLabel(node), cond: matchCond, included: true, note: `→ ${ns}#${fenixId}` });
      const valueText = attr(node, 'value');
      const importValue = valueText && valueText.trim() !== '' ? evalValue(st, valueText, ctx) : undefined;
      // value 求值必须是普通对象才能替换上下文，否则回退到当前 ctx
      const subCtx =
        importValue !== null && typeof importValue === 'object' && !Array.isArray(importValue)
          ? (importValue as Record<string, unknown>)
          : ctx;
      st.importStack.push(key);
      try {
        processChildren(st, target.children, subCtx, deps);
      } finally {
        st.importStack.pop();
      }
      return;
    }
  }
}

function finishRender(st: SqlState, ctx: Record<string, unknown>, deps: RenderDeps): RenderResult {
  const raw = st.join.join('');
  const { out, trace } = renderTemplate(raw, ctx, [], (cond) => deps.overrides?.get(`if:${cond}`));
  let sql = replaceBlank(out);
  // #{xxx} → :fixDot(xxx)，求值入参数
  sql = sql.replace(/#\{([^}]+)\}/g, (whole, expr: string) => {
    const name = fixDot(expr);
    st.params.set(name, evalValue(st, expr, ctx));
    return ':' + name;
  });
  sql = replaceWhereAndOr(sql);
  // @if 分支命中情况并入 branches
  for (const t of trace as TemplateTrace[]) {
    st.branches.push({ label: `@if{${t.cond}}`, included: t.hit });
  }
  return {
    sql,
    params: [...st.params.entries()].map(([name, value]) => ({ name, value })),
    branches: st.branches,
    warnings: st.warnings,
  };
}

/** StringHelper.replaceBlank 忠实复刻：去掉 | 和 \t\r\n，多空格压一，trim */
export function replaceBlank(s: string): string {
  return s
    .replace(/[|\t\r\n]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function replaceWhereAndOr(s: string): string {
  let r = s
    .replace(/ WHERE AND | WHERE OR /gi, ' WHERE ')
    .replace(/ WHERE ORDER BY /gi, ' ORDER BY ')
    .replace(/ WHERE GROUP BY /gi, ' GROUP BY ');
  if (r.endsWith(' WHERE')) {
    r = r.slice(0, r.lastIndexOf(' WHERE'));
  }
  return r;
}
