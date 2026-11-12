/**
 * 诊断：
 *  对齐（v0.1）
 *    - XML：namespace 指向的 Dao 不存在 = Error；id 无对应 @QueryFenix 方法 = Warning
 *    - Java：@QueryFenix 方法无对应 XML 语句 = Error
 *  v0.2
 *    - match / whenN / value / start / end / @if{} 语法校验（MVEL 子集）= Warning
 *    - 表达式引用的参数名不存在 = Error；参数 VO 字段不存在 = Error
 *    - 未注册的 fenix 标签 = Error（运行时 NodeNotFoundException）
 */

import * as vscode from 'vscode';
import { FenixIndex, isFenixXmlDoc, fqnFromUri } from './fenixIndex';
import { lineAt, lineStartOffset } from './xmlParser';
import { parseNamespace } from './navigation';
import { parseDaoFile, splitQueryFenixValue } from './javaScanner';
import { parseFenixDocument, RNode, RChild, KNOWN_TAGS } from './sqlRenderer';
import { refsOfExpr, validateExpr } from './fenixExpr';

const MAX_DIAGS = 100;

export class FenixDiagnostics implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection;

  constructor(private index: FenixIndex) {
    this.collection = vscode.languages.createDiagnosticCollection('fenix-helper');
  }

  async checkDocument(doc: vscode.TextDocument): Promise<void> {
    if (isFenixXmlDoc(doc)) {
      await this.checkXmlDoc(doc);
    } else if (doc.languageId === 'java') {
      await this.checkJavaDoc(doc);
    }
  }

  async checkAllOpen(): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
      await this.checkDocument(doc);
    }
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }

  private async checkXmlDoc(doc: vscode.TextDocument): Promise<void> {
    const text = doc.getText();
    const diags: vscode.Diagnostic[] = [];
    const fd = parseFenixDocument(text);

    if (!fd.namespace) {
      diags.push(
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 10),
          'fenixs 根节点缺少 namespace 属性（应为 Dao 接口全限定名）',
          vscode.DiagnosticSeverity.Warning,
        ),
      );
      this.collection.set(doc.uri, diags);
      return;
    }

    const javaUri = await this.index.resolveJavaUri(fd.namespace);
    if (!javaUri) {
      diags.push(
        new vscode.Diagnostic(
          rangeOfNsAttr(text),
          `namespace 指向的 Dao 不存在：${fd.namespace}（检查类名或索引是否需要刷新）`,
          vscode.DiagnosticSeverity.Error,
        ),
      );
    }

    const dao = javaUri ? await this.index.readAndParseDao(javaUri) : null;

    for (const st of fd.statements) {
      if (diags.length >= MAX_DIAGS) {
        break;
      }
      const line = lineAt(text, st.start);
      const matchOf = (m: { name: string; queryFenixValue: string | null }): boolean => {
        if (!m.queryFenixValue) {
          return m.name === st.id;
        }
        const parts = splitQueryFenixValue(m.queryFenixValue);
        // 值形式必须同时匹配 id 与 namespace 后缀，否则会误认其它 Dao 的语句
        const ns = fd.namespace ?? '';
        return parts !== null && parts.fenixId === st.id && ns.endsWith('.' + parts.shortClassName);
      };
      // 对齐检查
      const methodOk = !dao ? false : dao.methods.some(matchOf);
      if (dao && !methodOk) {
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, lineLen(text, line)),
            `Dao ${fd.namespace.split('.').pop()} 中没有 @QueryFenix 方法「${st.id}」`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
      if (!dao) {
        continue;
      }
      const method = dao.methods.find(matchOf);
      // ---- v0.2：结构 + 表达式检查 ----
      const paramNames = new Set<string>(
        (method?.params ?? []).map((p) => p.paramName ?? p.varName),
      );
      const voFieldsCache = new Map<string, string[]>();
      const fieldsOfParam = async (name: string): Promise<string[]> => {
        if (voFieldsCache.has(name)) {
          return voFieldsCache.get(name)!;
        }
        const p = method?.params.find((x) => (x.paramName ?? x.varName) === name);
        let fields: string[] = [];
        if (p) {
          fields = await this.index.voFieldsOf(p.typeSimple, dao);
        }
        voFieldsCache.set(name, fields);
        return fields;
      };
      // 方法未解析到时，参数名集合为空会让每条引用都报 Error，属于噪音；只做标签检查
      await this.checkNodeTree(doc, text, diags, st.node, method ? paramNames : null, fieldsOfParam);
    }
    this.collection.set(doc.uri, diags);
  }

  private async checkNodeTree(
    doc: vscode.TextDocument,
    text: string,
    diags: vscode.Diagnostic[],
    node: RNode,
    paramNames: Set<string> | null,
    fieldsOfParam: (name: string) => Promise<string[]>,
  ): Promise<void> {
    const visit = async (n: RNode): Promise<void> => {
      if (diags.length >= MAX_DIAGS) {
        return;
      }
      // 未知标签
      if (!KNOWN_TAGS.has(n.tag)) {
        const line = lineAt(text, n.start);
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, lineLen(text, line)),
            `未注册的 fenix 标签 <${n.tag}>（运行时会抛 NodeNotFoundException）`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
      // 表达式属性检查
      const exprAttrs = ['match', 'when', 'when1', 'when2', 'when3', 'value', 'value1', 'value2', 'value3', 'start', 'end'];
      for (const a of n.attrs) {
        if (!exprAttrs.includes(a.name) || a.value.trim() === '') {
          continue;
        }
        // 语法
        const v = validateExpr(a.value);
        if (!v.ok) {
          const rng = refRangeInSource(doc, a.valueStart, a.value, '');
          diags.push(
            new vscode.Diagnostic(
              rng,
              `表达式语法错误：${v.msg}（match/when/value 是 MVEL 表达式）`,
              vscode.DiagnosticSeverity.Warning,
            ),
          );
          continue;
        }
        // 引用检查
        const refs = refsOfExpr(a.value);
        if (Array.isArray(refs)) {
          await this.checkRefs(doc, diags, refs, a.valueStart, a.value, paramNames, fieldsOfParam);
        }
      }
      // set 的 matchN/valueN（已在上面的 exprAttrs 里校验过的跳过，避免重复诊断）
      for (const a of n.attrs) {
        if (/^(match|value)\d$/.test(a.name) && a.value.trim() !== '' && !exprAttrs.includes(a.name)) {
          const v = validateExpr(a.value);
          if (!v.ok) {
            diags.push(
              new vscode.Diagnostic(
                refRangeInSource(doc, a.valueStart, a.value, ''),
                `表达式语法错误：${v.msg}`,
                vscode.DiagnosticSeverity.Warning,
              ),
            );
          }
        }
      }
      // 子节点
      for (const c of n.children) {
        if (c.kind === 'text') {
          // 必须用 raw：c.text 已反转义，实体（&lt; &amp;）会让 m.index 与文档 offset 错位
          await this.checkText(doc, diags, c.raw, c.start, paramNames, fieldsOfParam);
        } else {
          await visit(c);
        }
      }
    };
    await visit(node);
  }

  private async checkText(
    doc: vscode.TextDocument,
    diags: vscode.Diagnostic[],
    textNode: string,
    nodeStart: number,
    paramNames: Set<string> | null,
    fieldsOfParam: (name: string) => Promise<string[]>,
  ): Promise<void> {
    // @if{...} / @{...} / #{...} 表达式
    const exprRe = /@(?:if|elseif)\{([^}]*)\}|@\{([^}]*)\}|#\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = exprRe.exec(textNode)) !== null) {
      if (diags.length >= MAX_DIAGS) {
        return;
      }
      const expr = m[1] ?? m[2] ?? m[3] ?? '';
      const exprStart = nodeStart + m.index + m[0].indexOf('{') + 1;
      if (expr.trim() === '') {
        continue;
      }
      const v = validateExpr(expr);
      if (!v.ok) {
        diags.push(
          new vscode.Diagnostic(
            refRangeInSource(doc, exprStart, expr, ''),
            `表达式语法错误：${v.msg}（@if{}/@{}/#{ } 内是 MVEL 表达式）`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
        continue;
      }
      const refs = refsOfExpr(expr);
      if (Array.isArray(refs)) {
        await this.checkRefs(doc, diags, refs, exprStart, expr, paramNames, fieldsOfParam);
      }
    }
  }

  private async checkRefs(
    doc: vscode.TextDocument,
    diags: vscode.Diagnostic[],
    refs: string[][],
    sourceStart: number,
    source: string,
    paramNames: Set<string> | null,
    fieldsOfParam: (name: string) => Promise<string[]>,
  ): Promise<void> {
    // paramNames === null 表示未解析到方法，不做引用校验（避免噪音 Error）
    if (paramNames === null) {
      return;
    }
    const reported = new Set<string>();
    for (const path of refs) {
      const name = path[0];
      const dotted = path.join('.');
      if (reported.has(dotted)) {
        continue;
      }
      if (!paramNames.has(name)) {
        reported.add(dotted);
        diags.push(
          new vscode.Diagnostic(
            refRangeInSource(doc, sourceStart, source, dotted),
            paramNames.size > 0
              ? `引用了未定义的参数「${name}」（方法的参数：${[...paramNames].join(', ')}）`
              : `引用了未定义的参数「${name}」（该方法没有参数）`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
        continue;
      }
      if (path.length >= 2) {
        const fields = await fieldsOfParam(name);
        if (fields.length > 0 && !fields.includes(path[1])) {
          reported.add(dotted);
          diags.push(
            new vscode.Diagnostic(
              refRangeInSource(doc, sourceStart, source, dotted),
              `参数「${name}」的类型中不存在字段「${path[1]}」`,
              vscode.DiagnosticSeverity.Error,
            ),
          );
        }
      }
    }
  }

  private async checkJavaDoc(doc: vscode.TextDocument): Promise<void> {
    const fqn = fqnFromUri(doc.uri);
    if (!fqn) {
      return;
    }
    const dao = parseDaoFile(doc.getText());
    const diags: vscode.Diagnostic[] = [];
    for (const m of dao.methods) {
      const target = this.index.resolveQueryFenixTarget(fqn, m);
      if (!target) {
        diags.push(
          new vscode.Diagnostic(
            new vscode.Range(
              doc.positionAt(m.annotationOffset),
              doc.positionAt(Math.min(m.endOffset + 1, m.annotationOffset + 200)),
            ),
            `@QueryFenix 方法「${m.name}」找不到对应 fenix XML 语句（${fqn}#${m.name}）`,
            vscode.DiagnosticSeverity.Error,
          ),
        );
      }
    }
    this.collection.set(doc.uri, diags);
  }
}

/** 在表达式源文本里定位引用（dotted）的范围；找不到则退回整个表达式 */
function refRangeInSource(doc: vscode.TextDocument, sourceStart: number, source: string, needle: string): vscode.Range {
  const idx = needle ? source.indexOf(needle) : -1;
  if (idx >= 0) {
    return new vscode.Range(
      doc.positionAt(sourceStart + idx),
      doc.positionAt(sourceStart + idx + needle.length),
    );
  }
  return new vscode.Range(doc.positionAt(sourceStart), doc.positionAt(sourceStart + source.length));
}

function rangeOfNsAttr(text: string): vscode.Range {
  const rootTag = /<fenixs\b[^>]*?>/.exec(text);
  if (!rootTag) {
    return new vscode.Range(0, 0, 0, 20);
  }
  const nsMatch = /namespace\s*=\s*"([^"]*)"/.exec(rootTag[0]);
  const attrIdx = nsMatch ? rootTag[0].indexOf('namespace') : 0;
  const start = rootTag.index + attrIdx;
  const line = lineAt(text, start);
  const col = start - lineStartOffset(text, line);
  const endCol = nsMatch ? col + nsMatch[0].length : col + 10;
  return new vscode.Range(line, col, line, endCol);
}

function lineLen(text: string, line: number): number {
  const ls = lineStartOffset(text, line);
  const nl = text.indexOf('\n', ls);
  return (nl < 0 ? text.length : nl) - ls;
}
