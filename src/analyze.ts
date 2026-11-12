/**
 * 语句「条件 / 参数」分析（纯函数，无 vscode 依赖）。
 *
 * 预览面板要按「条件」列出可勾选项，并能强制包含/排除某条条件，
 * 因此这里把语句拆成：
 *   - conditions：带 gating 条件（match / when / match2…）的标签，以及文本里的 @if{...} 块
 *   - freeParams：只出现在 #{...} / @{...} 插值或 value 里、不属于任何条件的参数
 */

import { RNode, RChild, fixDot } from './sqlRenderer';
import { refsOfExpr } from './fenixExpr';

export interface CondItem {
  /** 稳定 key：tag@<offset> / if:<cond> / choose@<offset>:when2 … */
  key: string;
  kind: 'tag' | 'if';
  /** 面板第一列展示的名称 */
  label: string;
  /** 原始条件表达式（tag 的 match / @if 的 cond），无则 undefined */
  cond?: string;
  /** 该条件涉及的参数（dotted path 的根 + 完整路径） */
  params: string[];
  /** 该行需要输入的参数路径（如 qv.plant、qv.start） */
  inputs: string[];
}

export interface Analysis {
  conditions: CondItem[];
  /** 未挂在任何条件下的参数（纯插值） */
  freeParams: string[];
}

/** 条件标签上参与「取值」的属性 */
const VALUE_ATTRS = ['value', 'value2', 'value3', 'start', 'end', 'pattern'];
/** 可作为 gating 的属性（含编号） */
const GATE_ATTRS = ['match', 'match2', 'match3'];

function attrOf(node: RNode, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}

/** 表达式里引用到的参数路径 */
function refsInExpr(expr: string | undefined): string[] {
  if (!expr || expr.trim() === '') {
    return [];
  }
  const refs = refsOfExpr(expr);
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.map((p) => p.join('.'));
}

/** 文本里 #{...} / @{...} 引用的参数 */
function refsInText(text: string): string[] {
  const out: string[] = [];
  const re = /#\{([^}]*)\}|@\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const expr = (m[1] ?? m[2] ?? '').trim();
    if (!expr) {
      continue;
    }
    const refs = refsOfExpr(expr);
    if (Array.isArray(refs)) {
      out.push(...refs.map((p) => p.join('.')));
    }
  }
  return out;
}

/** 参数路径的「根」（qv.plant → qv） */
export function rootOf(dotted: string): string {
  const i = dotted.indexOf('.');
  return i > 0 ? dotted.slice(0, i) : dotted;
}

/** 只保留真正的参数引用（过滤 empty/null/true/false 等关键字与纯数字） */
function isParamRef(dotted: string): boolean {
  if (!dotted) {
    return false;
  }
  const root = rootOf(dotted);
  return !['empty', 'null', 'true', 'false'].includes(root) && !/^\d/.test(root);
}

export function analyzeStatement(stmt: RNode): Analysis {
  const conditions: CondItem[] = [];
  const allRefs = new Set<string>();
  const condRefs = new Set<string>();

  const addRefs = (refs: string[], into: Set<string>) => {
    for (const r of refs.filter(isParamRef)) {
      into.add(r);
      allRefs.add(r);
    }
  };
  /** 只登记到 allRefs（纯插值参数不属于任何条件，否则会被 condRefs 减掉） */
  const addFreeRefs = (refs: string[]) => {
    for (const r of refs.filter(isParamRef)) {
      allRefs.add(r);
    }
  };

  const walk = (node: RNode): void => {
    // ---- 标签条件 ----
    const hasGate = GATE_ATTRS.some((a) => attrOf(node, a) !== undefined);
    if (hasGate) {
      const field = attrOf(node, 'field') ?? '';
      // 每行一个条件：优先用 match（简单标签），set/choose 用编号属性
      const gateAttr = GATE_ATTRS.find((a) => attrOf(node, a) !== undefined)!;
      const cond = attrOf(node, gateAttr);
      // 该条件的取值属性（value/start/end…）
      const inputs: string[] = [];
      for (const a of VALUE_ATTRS) {
        const v = attrOf(node, a);
        if (v && v.trim() !== '') {
          const refs = refsInExpr(v).filter(isParamRef);
          addRefs(refs, condRefs);
          inputs.push(...refs);
        }
      }
      // 条件表达式里引用的参数也算该条件涉及
      const condRefList = refsInExpr(cond).filter(isParamRef);
      addRefs(condRefList, condRefs);
      const label =
        node.tag === 'set' || node.tag === 'choose'
          ? `<${node.tag} ${field ? `field="${field}"` : gateAttr}…>`
          : `<${node.tag}${field ? ` field="${field}"` : ''}>`;
      conditions.push({
        key: `tag@${node.start}`,
        kind: 'tag',
        label,
        cond,
        params: [...new Set([...condRefList, ...inputs])],
        inputs: [...new Set(inputs)],
      });
    } else {
      // 无 gating：value 里的参数算自由参数
      for (const a of VALUE_ATTRS) {
        const v = attrOf(node, a);
        if (v && v.trim() !== '') {
          addRefs(refsInExpr(v).filter(isParamRef), condRefs);
        }
      }
    }

    for (const c of node.children) {
      if (c.kind === 'text') {
        // ---- @if 条件块 ----
        const re = /@(?:if|elseif)\{([^}]*)\}/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(c.raw)) !== null) {
          const cond = m[1].trim();
          if (cond && cond !== 'false' && cond !== 'true') {
            const refs = refsInExpr(cond).filter(isParamRef);
            addRefs(refs, condRefs);
            conditions.push({
              key: `if:${cond}`,
              kind: 'if',
              label: `@if{${cond}}`,
              cond,
              params: [...new Set(refs)],
              inputs: [...new Set(refs.filter((r) => r.includes('.')))],
            });
          }
        }
        // 纯插值参数（#{} / @{}）：只登记，不算进 condRefs
        addFreeRefs(refsInText(c.raw));
      } else {
        walk(c);
      }
    }
  };
  walk(stmt);

  const freeParams = [...allRefs].filter((r) => !condRefs.has(r));
  return { conditions, freeParams: [...new Set(freeParams)] };
}

/** 由「参数路径 → 输入值」构建渲染上下文（支持 qv.plant 这类嵌套路径） */
export function buildContext(values: Record<string, string>): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const [path, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null) {
      continue;
    }
    const segs = path.split('.');
    let cur: Record<string, unknown> = ctx;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (typeof cur[seg] !== 'object' || cur[seg] === null) {
        cur[seg] = {};
      }
      cur = cur[seg] as Record<string, unknown>;
    }
    cur[segs[segs.length - 1]] = coerce(raw);
  }
  return ctx;
}

/** 输入框字符串转值：数字转 number，其余保持字符串；空串保持 ''（!= empty 为 false） */
function coerce(raw: string): unknown {
  const t = raw.trim();
  if (t === '') {
    return '';
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    return Number(t);
  }
  return raw;
}

/**
 * 把 SQL 里的 :name 命名参数替换为实际值，便于直接复制执行。
 * 参数名与 fixDot 规则一致（qv.plant → qv_plant）。
 */
export function inlineParams(sql: string, params: Array<{ name: string; value: unknown }>): string {
  const map = new Map(params.map((p) => [p.name, p.value]));
  return sql.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    if (!map.has(name)) {
      return whole;
    }
    return sqlLiteral(map.get(name));
  });
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (typeof v === 'number') {
    return String(v);
  }
  if (typeof v === 'boolean') {
    return v ? '1' : '0';
  }
  if (Array.isArray(v)) {
    if (v.length === 0) {
      return 'null';
    }
    return '(' + v.map((x) => sqlLiteral(x)).join(', ') + ')';
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

export { fixDot };
