/**
 * Dao / VO Java 文件轻量解析（纯函数，无 vscode 依赖）。
 * 只解析 fenix 相关所需：包名、类型名、import 表、@QueryFenix 方法、@Param 参数、VO 字段。
 */

export interface DaoParam {
  /** @Param 注解名；无注解时为 null */
  paramName: string | null;
  varName: string;
  /** 简单类型名（如 QueryVo、List） */
  typeSimple: string;
}

export interface DaoMethod {
  name: string;
  /** 方法名在全文中的绝对 offset */
  nameOffset: number;
  /** @QueryFenix 注解 value（null = 空注解形式，id 取方法名） */
  queryFenixValue: string | null;
  /** 注解在全文中的绝对 offset */
  annotationOffset: number;
  /** 方法签名结束（';'）的绝对 offset */
  endOffset: number;
  params: DaoParam[];
}

export interface DaoInfo {
  pkg: string | null;
  typeName: string | null;
  /** 简单类名 → 全限定名（来自 import） */
  imports: Map<string, string>;
  methods: DaoMethod[];
}

const METHOD_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'return', 'new', 'do', 'try', 'else', 'assert',
]);

/** 解析 Dao 接口/类文件文本 */
/** 剥离 Java 注释（保留换行与字符位置，避免 offset 偏移） */
export function stripJavaComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

export function parseDaoFile(rawText: string): DaoInfo {
  // 注释掉的 @QueryFenix / 字段不该参与索引，否则会产生误报诊断和指向注释的跳转
  const text = stripJavaComments(rawText);
  const pkgM = /package\s+([\w.]+)\s*;/.exec(text);
  const typeM = /\b(?:interface|class)\s+(\w+)/.exec(text);

  const imports = new Map<string, string>();
  const impRe = /import\s+(?:static\s+)?([\w.]+)\.(\w+)\s*;/g;
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(text)) !== null) {
    imports.set(im[2], im[1] + '.' + im[2]);
  }

  const methods: DaoMethod[] = [];
  const qfRe = /@QueryFenix\s*(?:\(([^)]*)\))?/g;
  let qm: RegExpExecArray | null;
  while ((qm = qfRe.exec(text)) !== null) {
    const annotationOffset = qm.index;
    const args = qm[1] ?? '';
    // args 来自 ([^)]*)，本身不含结尾 ')'，所以不能用 (?:,|\)) 收尾。
    // 支持 @QueryFenix("A.b") 与 @QueryFenix(value = "A.b") 两种写法。
    const valueM = /^\s*"([^"]*)"/.exec(args) ?? /(?:^|[(,\s])value\s*=\s*"([^"]*)"/.exec(args);
    const queryFenixValue = valueM && valueM[1] !== '' ? valueM[1] : null;

    // 从注解之后到第一个 ';' 是方法头（可能夹杂其他注解）
    let i = qm.index + qm[0].length;
    const semi = text.indexOf(';', i);
    if (semi < 0 || semi - i > 4000) {
      continue;
    }
    const head = text.slice(i, semi);

    // 收集注解范围，避免把注解里的标识符误当方法名
    const annRanges: Array<[number, number]> = [];
    const annRe = /@\w+(\s*\([^()]*\))?/g;
    let am: RegExpExecArray | null;
    while ((am = annRe.exec(head)) !== null) {
      annRanges.push([am.index, am.index + am[0].length]);
    }

    const nameRe = /([A-Za-z_$][\w$]*)\s*\(/g;
    let nm: RegExpExecArray | null;
    let methodName: string | null = null;
    let methodNameRel = -1;
    while ((nm = nameRe.exec(head)) !== null) {
      const candName = nm[1];
      const candIndex = nm.index;
      if (METHOD_KEYWORDS.has(candName)) {
        continue;
      }
      const inAnn = annRanges.some(([s, e]) => candIndex >= s && candIndex < e);
      if (inAnn) {
        continue;
      }
      methodName = candName;
      methodNameRel = candIndex;
      break;
    }
    if (!methodName) {
      continue;
    }

    // 参数列表：从方法名后的 '(' 扫描到配对的 ')'
    const openRel = head.indexOf('(', methodNameRel);
    let depth = 0;
    let closeRel = -1;
    for (let p = openRel; p < head.length; p++) {
      if (head[p] === '(') {
        depth++;
      } else if (head[p] === ')') {
        depth--;
        if (depth === 0) {
          closeRel = p;
          break;
        }
      }
    }
    const paramsStr = closeRel > 0 ? head.slice(openRel + 1, closeRel) : '';

    methods.push({
      name: methodName,
      nameOffset: i + methodNameRel,
      queryFenixValue,
      annotationOffset,
      endOffset: semi,
      params: parseParams(paramsStr),
    });
    qfRe.lastIndex = semi;
  }

  return { pkg: pkgM ? pkgM[1] : null, typeName: typeM ? typeM[1] : null, imports, methods };
}

/** 拆分参数声明（顶层逗号，感知 <> 与 () 嵌套） */
function parseParams(paramsStr: string): DaoParam[] {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let inStr: string | null = null;
  let cur = '';
  for (const ch of paramsStr) {
    // 注解里的字符串（如 @DateTimeFormat(pattern = "yyyy-MM-dd,HH")）不能被逗号切断
    if (inStr) {
      cur += ch;
      if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === '<') {
      depthAngle++;
    } else if (ch === '>') {
      depthAngle = Math.max(0, depthAngle - 1);
    } else if (ch === '(') {
      depthParen++;
    } else if (ch === ')') {
      depthParen = Math.max(0, depthParen - 1);
    }
    if (ch === ',' && depthAngle === 0 && depthParen === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) {
    parts.push(cur);
  }

  const params: DaoParam[] = [];
  for (const part of parts) {
    const pm = /@Param\s*\(\s*(?:"([^"]*)"|value\s*=\s*"([^"]*)")\s*\)/.exec(part);
    const paramName = pm ? (pm[1] ?? pm[2] ?? null) : null;
    // 去掉所有注解后取「类型 变量名」
    const bare = part
      .replace(/@\w+(\s*\([^()]*\))?/g, ' ')
      .replace(/\bfinal\b/g, ' ')
      .replace(/\.\.\./g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!bare) {
      continue;
    }
    const tm = /^([\w.$]+(?:\s*<[\w.$,\s<>\[\]?]*>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)$/.exec(bare);
    if (!tm) {
      continue;
    }
    params.push({ paramName, varName: tm[2], typeSimple: tm[1].split('<')[0].trim() });
  }
  return params;
}

export interface VoInfo {
  fields: string[];
  extendsSimple: string | null;
  /** 该类型自己的包名（解析父类时必须用它，不能用 Dao 的） */
  pkg: string | null;
  /** 该类型自己的 import 表（同上） */
  imports: Map<string, string>;
}

/** 解析 VO/实体类字段（含 Lombok 场景），不追继承链（由调用方处理） */
export function parseVoFile(rawText: string): VoInfo {
  const text = stripJavaComments(rawText);
  const pkgM = /package\s+([\w.]+)\s*;/.exec(text);
  const imports = new Map<string, string>();
  const impRe = /import\s+(?:static\s+)?([\w.]+)\.(\w+)\s*;/g;
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(text)) !== null) {
    imports.set(im[2], im[1] + '.' + im[2]);
  }
  const extM = /(?:class|interface)\s+\w+(?:\s+extends\s+([\w.$]+))?/.exec(text);
  const fields: string[] = [];
  const fRe = /(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?[\w.$]+(?:\s*<[^;=]*?>)?(?:\s*\[\s*\])*\s+(\w+)\s*[;=]/g;
  let fm: RegExpExecArray | null;
  while ((fm = fRe.exec(text)) !== null) {
    fields.push(fm[1]);
  }
  return {
    fields,
    extendsSimple: extM && extM[1] ? extM[1] : null,
    pkg: pkgM ? pkgM[1] : null,
    imports,
  };
}

/** 依据简单类型名和 Dao 的 import 表推导全限定名 */
export function resolveFqn(typeSimple: string, dao: DaoInfo): string {
  if (typeSimple.includes('.')) {
    return typeSimple;
  }
  // 显式 import 优先，其次按同包兜底（与 Dao 同包的类型没有 import 语句）
  const imported = dao.imports.get(typeSimple);
  if (imported) {
    return imported;
  }
  return dao.pkg ? `${dao.pkg}.${typeSimple}` : typeSimple;
}

/**
 * @QueryFenix 值形式 → (namespace 后缀, fenixId)。
 * 空值形式由调用方用「Dao FQN + 方法名」。
 */
export function splitQueryFenixValue(value: string): { shortClassName: string; fenixId: string } | null {
  const parts = value.split('.');
  if (parts.length < 2) {
    return null;
  }
  return { shortClassName: parts[0], fenixId: parts[1] };
}
