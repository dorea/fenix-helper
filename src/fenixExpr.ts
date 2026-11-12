/**
 * fenix（MVEL 子集）表达式引擎 + MVEL 模板渲染器 —— 纯函数，无 vscode 依赖。
 *
 * 依据 fenix v2.7.0 源码：
 *  - ParseHelper：match / when / @if{} 条件走 MVEL.eval；`empty` 是空值判断关键字；
 *    `?` 前缀是 null-safe；支持 && || ! == != < > <= >= 和括号。
 *  - FenixXmlBuilder：最终 SQL 整段过 MVEL TemplateRuntime：
 *    @if{cond}...@elseif{cond}...@else{}...@end{}、@{expr} 插值、@@ 转义。
 *
 * 本引擎实现实际项目中最常用的子集；解析失败即视为可疑语法（诊断用）。
 */

export interface Tok {
  t: 'id' | 'num' | 'str' | 'op';
  v: string;
  pos: number;
}

export interface TokError {
  error: string;
  pos: number;
}

const KEYWORDS = new Set(['empty', 'true', 'false', 'null']);

export function tokenize(src: string): Tok[] | TokError {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) {
        j++;
      }
      toks.push({ t: 'id', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // 数字（整数/小数/科学计数法）
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9]/.test(src[j])) {
        j++;
      }
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) {
          j++;
        }
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') {
          k++;
        }
        if (/[0-9]/.test(src[k] ?? '')) {
          j = k;
          while (j < src.length && /[0-9]/.test(src[j])) {
            j++;
          }
        }
      }
      toks.push({ t: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    // 字符串
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          j++;
        }
        j++;
      }
      if (j >= src.length) {
        return { error: `字符串未闭合（${c}）`, pos: i };
      }
      toks.push({ t: 'str', v: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    // 运算符（双字符优先）
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      toks.push({ t: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('!<>()?.,+-*/%[]'.includes(c)) {
      toks.push({ t: 'op', v: c, pos: i });
      i++;
      continue;
    }
    return { error: `非法字符「${c}」`, pos: i };
  }
  return toks;
}

// ---------- AST ----------

export type Expr =
  | { k: 'lit'; v: unknown }
  | { k: 'ref'; path: string[] }
  | { k: 'empty' }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'un'; op: '!' | '?'; e: Expr }
  | { k: 'call'; callee: Expr; args: Expr[] }
  | { k: 'index'; obj: Expr; idx: Expr };

class ExprParser {
  private i = 0;

  constructor(private toks: Tok[]) {}

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  private eatOp(...ops: string[]): Tok | null {
    const t = this.peek();
    if (t && t.t === 'op' && ops.includes(t.v)) {
      this.i++;
      return t;
    }
    return null;
  }

  private eatKw(...kws: string[]): Tok | null {
    const t = this.peek();
    if (t && t.t === 'id' && kws.includes(t.v)) {
      this.i++;
      return t;
    }
    return null;
  }

  parse(): Expr | { error: string; pos: number } {
    if (this.toks.length === 0) {
      return { error: '空表达式', pos: 0 };
    }
    const e = this.or();
    if ('error' in e) {
      return e;
    }
    if (this.i < this.toks.length) {
      return { error: `表达式末尾有多余内容「${this.toks[this.i].v}」`, pos: this.toks[this.i].pos };
    }
    return e;
  }

  private or(): Expr | Err {
    let l = this.and();
    if ('error' in l) {
      return l;
    }
    for (;;) {
      const op = this.eatOp('||') ?? this.eatKw('or');
      if (!op) {
        return l;
      }
      const r = this.and();
      if ('error' in r) {
        return r;
      }
      l = { k: 'bin', op: '||', l, r };
    }
  }

  private and(): Expr | Err {
    let l = this.cmp();
    if ('error' in l) {
      return l;
    }
    for (;;) {
      const op = this.eatOp('&&') ?? this.eatKw('and');
      if (!op) {
        return l;
      }
      const r = this.cmp();
      if ('error' in r) {
        return r;
      }
      l = { k: 'bin', op: '&&', l, r };
    }
  }

  private cmp(): Expr | Err {
    const l = this.add();
    if ('error' in l) {
      return l;
    }
    const op = this.eatOp('==', '!=', '<', '>', '<=', '>=');
    if (!op) {
      return l;
    }
    const r = this.add();
    if ('error' in r) {
      return r;
    }
    return { k: 'bin', op: op.v, l, r };
  }

  private add(): Expr | Err {
    let l = this.mul();
    if ('error' in l) {
      return l;
    }
    for (;;) {
      const op = this.eatOp('+', '-');
      if (!op) {
        return l;
      }
      const r = this.mul();
      if ('error' in r) {
        return r;
      }
      l = { k: 'bin', op: op.v, l, r };
    }
  }

  private mul(): Expr | Err {
    let l = this.unary();
    if ('error' in l) {
      return l;
    }
    for (;;) {
      const op = this.eatOp('*', '/', '%');
      if (!op) {
        return l;
      }
      const r = this.unary();
      if ('error' in r) {
        return r;
      }
      l = { k: 'bin', op: op.v, l, r };
    }
  }

  private unary(): Expr | Err {
    if (this.eatOp('!')) {
      const e = this.unary();
      return 'error' in e ? e : { k: 'un', op: '!', e };
    }
    if (this.eatOp('?')) {
      const e = this.unary();
      return 'error' in e ? e : { k: 'un', op: '?', e };
    }
    // 一元正负：折叠进数字字面量，或生成 0 - x
    if (this.peek()?.t === 'op' && (this.peek()!.v === '-' || this.peek()!.v === '+')) {
      const sign = this.peek()!.v;
      this.i++;
      const e = this.unary();
      if ('error' in e) {
        return e;
      }
      if (e.k === 'lit' && typeof e.v === 'number') {
        return { k: 'lit', v: sign === '-' ? -e.v : e.v };
      }
      return sign === '-' ? { k: 'bin', op: '-', l: { k: 'lit', v: 0 }, r: e } : e;
    }
    return this.postfix(this.primary());
  }

  /** 支持 ref 后的方法调用 `ids.size()` 与下标 `ids[0]`（MVEL 常见写法） */
  private postfix(base: Expr | Err): Expr | Err {
    let e = base;
    for (;;) {
      if ('error' in e) {
        return e;
      }
      const t = this.peek();
      if (!t || t.t !== 'op') {
        return e;
      }
      if (t.v === '(') {
        // 方法调用：跳过配对括号（参数不参与求值，保持简单）
        this.i++;
        let depth = 1;
        while (this.i < this.toks.length && depth > 0) {
          const cur = this.toks[this.i++];
          if (cur.t === 'op' && cur.v === '(') {
            depth++;
          } else if (cur.t === 'op' && cur.v === ')') {
            depth--;
          }
        }
        if (depth !== 0) {
          return { error: '括号未闭合', pos: t.pos };
        }
        e = { k: 'call', callee: e, args: [] };
        continue;
      }
      if (t.v === '[') {
        this.i++;
        const idx = this.or();
        if ('error' in idx) {
          return idx;
        }
        if (!this.eatOp(']')) {
          return { error: '下标未闭合', pos: t.pos };
        }
        e = { k: 'index', obj: e, idx };
        continue;
      }
      return e;
    }
  }

  private primary(): Expr | Err {
    const t = this.peek();
    if (!t) {
      return { error: '表达式意外结束', pos: 0 };
    }
    if (t.t === 'num') {
      this.i++;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.t === 'str') {
      this.i++;
      return { k: 'lit', v: t.v };
    }
    if (t.t === 'id') {
      if (KEYWORDS.has(t.v)) {
        this.i++;
        if (t.v === 'empty') {
          return { k: 'empty' };
        }
        return { k: 'lit', v: t.v === 'true' ? true : t.v === 'false' ? false : null };
      }
      // 引用链：a.b.c
      this.i++;
      const path = [t.v];
      while (this.eatOp('.')) {
        const seg = this.peek();
        if (!seg || seg.t !== 'id') {
          return { error: '点号后缺少属性名', pos: this.i < this.toks.length ? this.toks[this.i].pos : t.pos };
        }
        path.push(seg.v);
        this.i++;
      }
      return { k: 'ref', path };
    }
    if (t.t === 'op' && t.v === '(') {
      this.i++;
      const e = this.or();
      if ('error' in e) {
        return e;
      }
      if (!this.eatOp(')')) {
        return { error: '括号未闭合', pos: t.pos };
      }
      return e;
    }
    return { error: `此处不应出现「${t.v}」`, pos: t.pos };
  }
}

type Err = { error: string; pos: number };

export function parseExpr(src: string): Expr | Err {
  const toks = tokenize(src);
  if (!Array.isArray(toks)) {
    return toks;
  }
  return new ExprParser(toks).parse();
}

export function validateExpr(src: string): { ok: true } | { ok: false; msg: string; pos: number } {
  const r = parseExpr(src);
  if ('error' in r) {
    return { ok: false, msg: r.error, pos: r.pos };
  }
  return { ok: true };
}

// ---------- 求值 ----------

type Ctx = Record<string, unknown>;

/** MVEL `empty`：null / 空串 / 空集合 / 空 Map */
export function isEmptyVal(v: unknown): boolean {
  if (v === null || v === undefined || v === '') {
    return true;
  }
  if (Array.isArray(v) && v.length === 0) {
    return true;
  }
  if (typeof v === 'object' && Object.keys(v as object).length === 0) {
    return true;
  }
  return false;
}

/** ParseHelper.isTrue：仅 Boolean.TRUE 通过 */
export function isTrueVal(v: unknown): boolean {
  return v === true;
}

function refLookup(path: string[], ctx: Ctx): unknown {
  let cur: unknown = ctx;
  for (const seg of path) {
    if (cur === null || cur === undefined) {
      return undefined;
    }
    if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  if (b === null || b === undefined) {
    return false;
  }
  return String(a) === String(b);
}

function cmpOrder(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') {
    return na - nb;
  }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function evalExpr(e: Expr, ctx: Ctx): unknown {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'empty':
      return 'empty';
    case 'ref':
      return refLookup(e.path, ctx);
    case 'call': {
      // ids.size() 被解析为 ref(['ids','size']) + call：最后一个路径段是方法名，其余是接收者
      let recv: unknown;
      let name = '';
      if (e.callee.k === 'ref') {
        const path = e.callee.path;
        name = path[path.length - 1];
        recv = path.length > 1 ? refLookup(path.slice(0, -1), ctx) : undefined;
      } else {
        recv = evalExpr(e.callee, ctx);
      }
      if (name === 'size' || name === 'length') {
        if (Array.isArray(recv)) {
          return recv.length;
        }
        if (typeof recv === 'string') {
          return recv.length;
        }
        if (recv && typeof recv === 'object') {
          return Object.keys(recv as object).length;
        }
        return 0;
      }
      if (name === 'isEmpty') {
        return isEmptyVal(recv);
      }
      if (name === 'toLowerCase') {
        return typeof recv === 'string' ? recv.toLowerCase() : recv;
      }
      if (name === 'toUpperCase') {
        return typeof recv === 'string' ? recv.toUpperCase() : recv;
      }
      if (name === 'trim') {
        return typeof recv === 'string' ? recv.trim() : recv;
      }
      // 未知方法：返回 undefined（不误报为 true）
      return undefined;
    }
    case 'index': {
      const obj = evalExpr(e.obj, ctx);
      const i = Number(evalExpr(e.idx, ctx));
      if (Array.isArray(obj)) {
        return obj[i];
      }
      if (typeof obj === 'string') {
        return obj[i];
      }
      return undefined;
    }
    case 'un':
      if (e.op === '!') {
        return !isTrueVal(evalExpr(e.e, ctx));
      }
      // `?` null-safe：引用缺失本来就不抛错，等价求值
      return evalExpr(e.e, ctx) ?? null;
    case 'bin': {
      const op = e.op;
      if (op === '&&') {
        const l = evalExpr(e.l, ctx);
        return isTrueVal(l) ? evalExpr(e.r, ctx) : l;
      }
      if (op === '||') {
        const l = evalExpr(e.l, ctx);
        return isTrueVal(l) ? l : evalExpr(e.r, ctx);
      }
      const l = evalExpr(e.l, ctx);
      const r = evalExpr(e.r, ctx);
      switch (op) {
        case '==':
          // `x == empty` / `x != empty`
          if (l === 'empty') {
            return isEmptyVal(r);
          }
          if (r === 'empty') {
            return isEmptyVal(l);
          }
          return looseEq(l, r);
        case '!=':
          if (l === 'empty') {
            return !isEmptyVal(r);
          }
          if (r === 'empty') {
            return !isEmptyVal(l);
          }
          return !looseEq(l, r);
        case '<':
          return cmpOrder(l, r) < 0;
        case '>':
          return cmpOrder(l, r) > 0;
        case '<=':
          return cmpOrder(l, r) <= 0;
        case '>=':
          return cmpOrder(l, r) >= 0;
        case '+':
          if (typeof l === 'string' || typeof r === 'string') {
            return String(l ?? '') + String(r ?? '');
          }
          return Number(l) + Number(r);
        case '-':
          return Number(l) - Number(r);
        case '*':
          return Number(l) * Number(r);
        case '/':
          return Number(l) / Number(r);
        case '%':
          return Number(l) % Number(r);
        default:
          return null;
      }
    }
  }
}

/** match/@if 条件求值：isMatch = 空条件恒真，否则要求布尔 true */
export function evalCondition(cond: string | undefined, ctx: Ctx): boolean {
  if (cond === undefined || cond.trim() === '') {
    return true;
  }
  const ast = parseExpr(cond);
  if ('error' in ast) {
    return false;
  }
  return isTrueVal(evalExpr(ast, ctx));
}

/** 收集表达式中的参数引用（dotted path），用于诊断 */
export function collectRefs(e: Expr, out: string[][] = []): string[][] {
  switch (e.k) {
    case 'ref':
      out.push(e.path);
      break;
    case 'bin':
      collectRefs(e.l, out);
      collectRefs(e.r, out);
      break;
    case 'un':
      collectRefs(e.e, out);
      break;
    case 'call':
      collectRefs(e.callee, out);
      break;
    case 'index':
      collectRefs(e.obj, out);
      collectRefs(e.idx, out);
      break;
    default:
      break;
  }
  return out;
}

export function refsOfExpr(src: string): string[][] | { error: string; pos: number } {
  const ast = parseExpr(src);
  if ('error' in ast) {
    return ast;
  }
  return collectRefs(ast);
}

// ---------- MVEL 模板渲染（@if / @elseif / @else / @end / @{} / @@） ----------

export interface TemplateTrace {
  cond: string;
  hit: boolean;
}

export function renderTemplate(
  tpl: string,
  ctx: Ctx,
  trace: TemplateTrace[] = [],
  /** 条件覆盖：返回 true/false 强制该分支，返回 undefined 走正常求值 */
  condOverride?: (cond: string) => boolean | undefined,
): { out: string; trace: TemplateTrace[] } {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const c = tpl[i];
    if (c !== '@') {
      out += c;
      i++;
      continue;
    }
    if (tpl.startsWith('@@', i)) {
      out += '@';
      i += 2;
      continue;
    }
    if (tpl.startsWith('@if{', i)) {
      const condEnd = findCloseBrace(tpl, i + 4);
      if (condEnd < 0) {
        out += tpl.slice(i);
        break;
      }
      const cond = tpl.slice(i + 4, condEnd);
      // 找配对的 @end{}（计数嵌套 @if{）
      const body = findIfBody(tpl, condEnd + 1);
      const branches = splitIfBranches(body.body, cond);
      let taken = false;
      for (const b of branches) {
        // 命中后不再求值后续分支（避免 trace 显示未渲染分支的假命中）
        if (taken) {
          break;
        }
        const forced = b.cond === undefined ? undefined : condOverride?.(b.cond);
        const hit = forced !== undefined ? forced : b.cond === undefined ? true : evalCondition(b.cond, ctx);
        trace.push({ cond: b.cond ?? '(else)', hit });
        if (hit) {
          out += renderTemplate(b.body, ctx, trace, condOverride).out;
          taken = true;
        }
      }
      i = body.end;
      continue;
    }
    if (tpl.startsWith('@{', i)) {
      const end = findCloseBrace(tpl, i + 2);
      if (end < 0) {
        out += tpl.slice(i);
        break;
      }
      const ast = parseExpr(tpl.slice(i + 2, end));
      const v = 'error' in ast ? null : evalExpr(ast, ctx);
      out += v === null || v === undefined ? '' : String(v);
      i = end + 1;
      continue;
    }
    out += '@';
    i++;
  }
  return { out, trace };
}

function findCloseBrace(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '{') {
      depth++;
    } else if (s[i] === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 从 @if{cond} 之后的位置找配对的 @end{}，返回 body 与结束位置 */
function findIfBody(s: string, from: number): { body: string; end: number } {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    // '@@' 是转义的 @，不参与结构识别
    if (s.startsWith('@@', i)) {
      i += 2;
      continue;
    }
    if (s.startsWith('@if{', i)) {
      depth++;
      i += 4;
      continue;
    }
    if (s.startsWith('@end{', i)) {
      depth--;
      if (depth === 0) {
        // '@end{}' 共 6 个字符
        return { body: s.slice(from, i), end: i + 6 };
      }
      i += 6;
      continue;
    }
    i++;
  }
  // 未闭合：吞到末尾
  return { body: s.slice(from), end: s.length };
}

interface IfBranch {
  cond?: string;
  body: string;
}

/** 把 @if 的 body 按顶层 @elseif/@else 分段；首段条件是 @if 自身的条件 */
function splitIfBranches(body: string, initialCond: string): IfBranch[] {
  const branches: IfBranch[] = [];
  let depth = 0;
  let curCond: string | undefined = initialCond;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    // '@@' 是转义的 @，跳过，避免误判为 @if{ / @end{ 边界
    if (body.startsWith('@@', i)) {
      i += 2;
      continue;
    }
    if (body.startsWith('@if{', i)) {
      depth++;
      i += 4;
      continue;
    }
    if (body.startsWith('@end{', i)) {
      depth = Math.max(0, depth - 1);
      // '@end{}' 共 6 个字符
      i += 6;
      continue;
    }
    if (depth === 0 && body.startsWith('@elseif{', i)) {
      branches.push({ cond: curCond, body: body.slice(start, i) });
      const condEnd = findCloseBrace(body, i + 8);
      if (condEnd < 0) {
        return branches;
      }
      curCond = body.slice(i + 8, condEnd);
      start = condEnd + 1;
      i = condEnd + 1;
      continue;
    }
    if (depth === 0 && body.startsWith('@else{', i)) {
      branches.push({ cond: curCond, body: body.slice(start, i) });
      curCond = undefined;
      // '@else{}' 共 7 个字符
      start = i + 7;
      i = start;
      continue;
    }
    i++;
  }
  branches.push({ cond: curCond, body: body.slice(start) });
  return branches;
}
