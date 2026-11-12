/**
 * fenix XML 轻量解析（纯函数，无 vscode 依赖，可被 node 直测）。
 *
 * 只解析索引和光标上下文需要的信息：
 *  - <fenixs namespace="...">       根节点命名空间
 *  - <fenix id="..." resultType>    语句节点（行号用于跳转）
 *  - 任意标签的属性 spans           用于判断光标在哪个属性值里
 */

export interface FenixStatement {
  id: string;
  resultType?: string;
  /** 0-based 行号 */
  line: number;
}

export interface FenixXmlInfo {
  namespace?: string;
  statements: FenixStatement[];
}

export interface AttrSpan {
  name: string;
  value: string;
  /** 属性值（含引号内部）在全文中的绝对范围 */
  valueStart: number;
  valueEnd: number;
}

export interface TagSpan {
  name: string;
  start: number;
  end: number;
  attrs: AttrSpan[];
}

/** 扫描 XML 注释区间（与 sqlRenderer.commentRanges 同逻辑，避免循环依赖此处独立实现） */
function commentRanges(text: string): Array<[number, number]> {
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

/** 解析 fenix XML：namespace + 所有 <fenix id> 语句（含行号，跳过注释掉的语句） */
export function parseFenixXml(text: string): FenixXmlInfo {
  const info: FenixXmlInfo = { statements: [] };
  const comments = commentRanges(text);

  const rootTag = /<fenixs\b[^>]*?>/.exec(text);
  if (rootTag) {
    const ns = /namespace\s*=\s*"([^"]*)"/.exec(rootTag[0]);
    if (ns && !comments.some(([s, e]) => rootTag.index >= s && rootTag.index < e)) {
      info.namespace = ns[1];
    }
  }

  // <fenix 后必须跟空白或 > 或 /，避免匹配到 <fenixs；跳过注释里的语句
  const fenixRe = /<fenix(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = fenixRe.exec(text)) !== null) {
    const hit = comments.find(([s, e]) => m!.index >= s && m!.index < e);
    if (hit) {
      fenixRe.lastIndex = hit[1];
      continue;
    }
    const tag = findTagSpans(text.slice(m.index), 1, m.index)[0];
    if (!tag) {
      continue;
    }
    const idAttr = tag.attrs.find((a) => a.name === 'id');
    if (!idAttr) {
      continue;
    }
    const rtAttr = tag.attrs.find((a) => a.name === 'resultType');
    info.statements.push({
      id: idAttr.value,
      resultType: rtAttr ? rtAttr.value : undefined,
      line: lineAt(text, m.index),
    });
  }
  return info;
}

/** offset 所在的 0-based 行号 */
export function lineAt(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/** offset 所在行的起始列数（用于整行 Range） */
export function lineStartOffset(text: string, line: number): number {
  let cur = 0;
  for (let l = 0; l < line; l++) {
    const nl = text.indexOf('\n', cur);
    if (nl < 0) {
      return 0;
    }
    cur = nl + 1;
  }
  return cur;
}

export function lineEndOffset(text: string, line: number): number {
  const start = lineStartOffset(text, line);
  const nl = text.indexOf('\n', start);
  return nl < 0 ? text.length : nl;
}

/**
 * 扫描文本中的开标签（含属性 spans）。
 * limit 控制最多解析几个（性能微优化），baseOffset 用于把相对 offset 换算回绝对 offset。
 */
export function findTagSpans(text: string, limit = Infinity, baseOffset = 0): TagSpan[] {
  const tags: TagSpan[] = [];
  const comments = commentRanges(text);
  // 引号里的 > 不结束标签；属性区允许换行
  const tagRe = /<([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null && tags.length < limit) {
    // 被注释掉的标签（本项目常见：老语句注释保留）不参与补全/CodeLens
    const hit = comments.find(([cs, ce]) => m!.index >= cs && m!.index < ce);
    if (hit) {
      tagRe.lastIndex = hit[1];
      continue;
    }
    const [, name, attrStr] = m;
    const attrs: AttrSpan[] = [];
    const nameStart = m.index + 1; // '<' 之后
    const attrBase = nameStart + name.length; // 属性区相对起点（在原文中的绝对位置）
    const attrRe = /\s+([\w:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrStr)) !== null) {
      const hasValue = am[2] !== undefined;
      const value = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
      let valueStart = attrBase + am.index + am[0].length; // 无值属性：span 空区间
      if (hasValue) {
        const quote = am[0].includes('"' + value + '"') ? '"' : "'";
        const rel = am[0].indexOf(quote + value + quote);
        if (rel >= 0) {
          valueStart = attrBase + am.index + rel + 1;
        }
      }
      valueStart += baseOffset;
      attrs.push({ name: am[1], value, valueStart, valueEnd: valueStart + value.length });
    }
    tags.push({ name, start: baseOffset + m.index, end: baseOffset + m.index + m[0].length, attrs });
  }
  return tags;
}

/** 找 offset 所在（或紧邻其前最近一个未闭合）的标签 */
export function findEnclosingTag(text: string, offset: number): TagSpan | null {
  // 光标可能正处于「标签写到一半」的位置：向前找最近的 '<'
  const lt = text.lastIndexOf('<', offset);
  if (lt < 0) {
    return null;
  }
  const tags = findTagSpans(text.slice(lt), 1, lt);
  const tag = tags[0];
  if (!tag) {
    // 标签未闭合（没有 '>'）→ 部分解析
    return parsePartialTag(text, lt, offset);
  }
  if (offset >= tag.start && offset <= tag.end) {
    return tag;
  }
  return null;
}

/** 光标在标签名/属性区但标签尚未闭合时的部分解析 */
function parsePartialTag(text: string, tagStart: number, offset: number): TagSpan | null {
  const seg = text.slice(tagStart, offset);
  const nameM = /^<([A-Za-z][\w:.-]*)/.exec(seg);
  if (!nameM) {
    return null;
  }
  const attrs: AttrSpan[] = [];
  const attrRe = /\s+([\w:.-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'))?/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(seg)) !== null) {
    const hasValue = am[2] !== undefined;
    const value = am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : '';
    let valueStart = tagStart + am.index + am[0].length;
    if (hasValue) {
      const quote = am[0].includes('"' + value + '"') ? '"' : "'";
      const rel = am[0].indexOf(quote + value + quote);
      if (rel >= 0) {
        valueStart = tagStart + am.index + rel + 1;
      }
    }
    attrs.push({ name: am[1], value, valueStart, valueEnd: valueStart + value.length });
  }
  return { name: nameM[1], start: tagStart, end: offset, attrs };
}

/**
 * 光标所在的最内层 <fenix id="..."> 语句 id（光标可在其文本内容/子标签/属性里）。
 * 返回 undefined 表示不在任何 fenix 语句内。
 */
export function findEnclosingStatementId(text: string, offset: number): string | undefined {
  const comments = commentRanges(text);
  // 向前找最近的 <fenix 开标签（允许任意空白，与 parseFenixXml 保持一致）
  const fenixRe = /<fenix(?=[\s/>])/g;
  const starts: number[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fenixRe.exec(text)) !== null) {
    if (fm.index > offset) {
      break;
    }
    if (!comments.some(([s, e]) => fm!.index >= s && fm!.index < e)) {
      starts.push(fm.index);
    }
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    const idx = starts[i];
    // 该标签与本位置之间若已出现 </fenix>，说明不在其内，继续往前找
    const closeIdx = text.indexOf('</fenix>', idx);
    if (closeIdx >= 0 && closeIdx < offset) {
      continue;
    }
    const idM = /id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text.slice(idx, idx + 500));
    return idM ? (idM[1] ?? idM[2]) : undefined;
  }
  return undefined;
}

/** 光标是否处于某个已知的「参数表达式」上下文：#{...} 或 @if{...} 中 */
export function inBracedExpression(text: string, offset: number): { openOffset: number; segment: string } | null {
  const lookback = Math.min(offset, 200);
  const seg = text.slice(offset - lookback, offset);
  // 找最后一个未被 '}' 关闭的 '{'（来自 #{ 或 @if{ 或 @{）
  const hashes: number[] = [];
  let openIdx = -1;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '{') {
      hashes.push(i);
      openIdx = i;
    } else if (ch === '}') {
      if (hashes.length > 0) {
        hashes.pop();
      }
      openIdx = hashes.length > 0 ? hashes[hashes.length - 1] : -1;
    }
  }
  if (openIdx < 0) {
    return null;
  }
  // 只认 #{ / @if{ / @elseif{ / @{ 这几种表达式开头，避免 SQL 里的普通 '{'（如 LIKE '%{'）误判
  const absOpen = offset - lookback + openIdx;
  const prev2 = text.slice(Math.max(0, absOpen - 8), absOpen + 1);
  if (!/(^|[#@](?:if|elseif)?)\{$/.test(prev2)) {
    return null;
  }
  return { openOffset: absOpen, segment: seg.slice(openIdx + 1) };
}
