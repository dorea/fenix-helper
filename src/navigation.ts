/**
 * 跳转定义：
 *  1. fenix XML：<fenix id> → Dao 方法；<fenixs namespace> / import namespace → Dao 类；resultType → 实体类；import fenixId → 目标语句
 *  2. Java：@QueryFenix 注解 或 方法名 → XML 语句行（**仅限这两个位置**，避免与 Java 语言服务抢参数/类型定义）
 *  3. CodeLens：XML 语句行「→ Dao.method」+「▶ 预览 SQL」；Java 方法上「→ 跳转到 XML」
 */

import * as vscode from 'vscode';
import { isFenixXmlDoc, fqnFromUri, FenixIndex } from './fenixIndex';
import { findEnclosingTag, findTagSpans, lineAt, lineStartOffset, parseFenixXml } from './xmlParser';
import { parseDaoFile, splitQueryFenixValue } from './javaScanner';
import { PREVIEW_CMD } from './preview';

/** text 中绝对 offset → vscode.Position（列 = 行内偏移） */
export function posAt(text: string, offset: number): vscode.Position {
  const line = lineAt(text, offset);
  return new vscode.Position(line, offset - lineStartOffset(text, line));
}

export function parseNamespace(text: string): string | undefined {
  // 复用索引解析（已做注释感知），避免「注释掉的根节点」导致两处视图不一致
  return parseFenixXml(text).namespace;
}

/** 读文件转文本；失败返回 null，避免 provider 抛异常 */
async function readTextOrNull(uri: vscode.Uri): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return null;
  }
}

/** namespace + fenix id → Dao 文件与方法 */
export async function locateDaoMethod(
  index: FenixIndex,
  namespace: string,
  id: string,
): Promise<{ uri: vscode.Uri; method: ReturnType<typeof parseDaoFile>['methods'][number] } | null> {
  const dao = await index.daoOf(namespace);
  const uri = await index.resolveJavaUri(namespace);
  if (!dao || !uri) {
    return null;
  }
  const method =
    dao.methods.find((m) => !m.queryFenixValue && m.name === id) ??
    dao.methods.find((m) => {
      if (!m.queryFenixValue) {
        return false;
      }
      const parts = splitQueryFenixValue(m.queryFenixValue);
      return parts !== null && parts.fenixId === id;
    });
  return method ? { uri, method } : null;
}

export class XmlToFenixDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: FenixIndex) {}

  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position):
    Promise<vscode.Definition | undefined> {
    if (!isFenixXmlDoc(doc)) {
      return undefined;
    }
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const tag = findEnclosingTag(text, offset);
    if (!tag) {
      return undefined;
    }
    const attr = tag.attrs.find((a) => offset >= a.valueStart - 1 && offset <= a.valueEnd + 1);
    if (!attr) {
      return undefined;
    }

    // 0) <fenixs namespace="..."> → Dao 类（点 namespace 直接跳到接口）
    if (attr.name === 'namespace' && attr.value) {
      if (tag.name === 'fenixs' || tag.name === 'import') {
        const uri = await this.index.resolveJavaUri(attr.value);
        if (uri) {
          return new vscode.Location(uri, new vscode.Range(0, 0, 0, 0));
        }
        return undefined;
      }
    }

    // 1) <fenix id="..."> → Dao 方法
    if (tag.name === 'fenix' && attr.name === 'id') {
      const ns = parseNamespace(text);
      if (!ns) {
        return undefined;
      }
      const hit = await locateDaoMethod(this.index, ns, attr.value);
      if (!hit) {
        return undefined;
      }
      const javaText = await readTextOrNull(hit.uri);
      if (javaText === null) {
        return undefined;
      }
      const start = posAt(javaText, hit.method.nameOffset);
      return new vscode.Location(hit.uri, new vscode.Range(start, start.translate(0, hit.method.name.length)));
    }

    // 2) resultType → Java 类文件
    if (attr.name === 'resultType' && attr.value) {
      const uri = await this.index.resolveJavaUri(attr.value);
      if (uri) {
        return new vscode.Location(uri, new vscode.Range(0, 0, 0, 0));
      }
      return undefined;
    }

    // 3) <import namespace="X" fenixId="y"/> → 目标语句
    if (tag.name === 'import' && attr.name === 'fenixId') {
      const id = attr.value;
      const nsAttr = tag.attrs.find((a) => a.name === 'namespace');
      const ns = nsAttr?.value || parseNamespace(text);
      if (!ns || !id) {
        return undefined;
      }
      const st = this.index.statements.get(`${ns}#${id}`);
      if (st) {
        return new vscode.Location(st.uri, new vscode.Range(st.line, 0, st.line, 200));
      }
    }
    return undefined;
  }
}

/** CodeLens 命令：从 XML 跳到 Dao 方法 */
export const GOTO_DAO_CMD = 'fenixHelper.gotoDaoMethod';
/** CodeLens 命令：从 Java 跳到 XML 语句 */
export const GOTO_XML_CMD = 'fenixHelper.gotoXmlStatement';

/**
 * 注意：CodeLens 的 arguments 会被序列化，vscode.Position 会退化成普通对象
 * {line, character}，再传给 executeDefinitionProvider 就报「unexpected type」。
 * 因此这里一律传纯数字。
 */
export async function gotoDaoMethodHandler(uri: vscode.Uri, line: number, character: number): Promise<void> {
  let locs: vscode.Location[] = [];
  try {
    locs = (await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      uri,
      new vscode.Position(line, character),
    )) as vscode.Location[];
  } catch {
    locs = [];
  }
  const target = locs?.[0];
  if (target) {
    await vscode.window.showTextDocument(target.uri, { selection: target.range });
  } else {
    void vscode.window.showWarningMessage('Fenix: 未找到对应的 Dao 方法（namespace 或 id 可能不对齐）');
  }
}

/** 从 Java 方法跳到 XML 语句：直接查索引，不经 executeDefinitionProvider */
export async function gotoXmlStatementHandler(
  index: FenixIndex,
  javaUri: vscode.Uri,
  line: number,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(javaUri);
  const fqn = fqnFromUri(javaUri);
  if (!fqn) {
    return;
  }
  const dao = parseDaoFile(doc.getText());
  // 找到该行所在的 @QueryFenix 方法
  const offset = doc.offsetAt(new vscode.Position(line, 0));
  const method = dao.methods.find((m) => offset >= m.annotationOffset && offset <= m.endOffset + 1);
  if (!method) {
    void vscode.window.showWarningMessage('Fenix: 光标不在 @QueryFenix 方法上');
    return;
  }
  const target = index.resolveQueryFenixTarget(fqn, method);
  const st = target ? index.statements.get(`${target.namespace}#${target.id}`) : undefined;
  if (!st) {
    void vscode.window.showWarningMessage(`Fenix: 找不到方法「${method.name}」对应的 XML 语句`);
    return;
  }
  const xmlDoc = await vscode.workspace.openTextDocument(st.uri);
  const maxLine = xmlDoc.lineCount - 1;
  const targetLine = Math.min(st.line, maxLine);
  await vscode.window.showTextDocument(xmlDoc, {
    selection: new vscode.Range(targetLine, 0, targetLine, 0),
    viewColumn: vscode.ViewColumn.Beside,
  });
}

/** XML 语句行上的 CodeLens */
export class FenixCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private index: FenixIndex) {}

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isFenixXmlDoc(doc)) {
      return [];
    }
    const text = doc.getText();
    const ns = parseNamespace(text);
    if (!ns) {
      return [];
    }
    const shortDao = ns.split('.').pop() ?? ns;
    const lenses: vscode.CodeLens[] = [];
    for (const tag of findTagSpans(text)) {
      if (tag.name !== 'fenix') {
        continue;
      }
      const idAttr = tag.attrs.find((a) => a.name === 'id');
      if (!idAttr) {
        continue;
      }
      const idLine = lineAt(text, idAttr.valueStart);
      // 注意：第二个参数是**行号**，不是 offset（之前传 offset 导致列错位，CodeLens 点击定位失败）
      const idCol = idAttr.valueStart - lineStartOffset(text, idLine);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(idLine, idCol, idLine, idCol + idAttr.value.length), {
          title: `$(go-to-file) ${shortDao}.${idAttr.value}`,
          tooltip: '跳转到 Dao 方法',
          command: GOTO_DAO_CMD,
          arguments: [doc.uri, idLine, idCol + 1],
        }),
      );
      const stmtLine = lineAt(text, tag.start);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(stmtLine, 0, stmtLine, 0), {
          title: '$(play) 预览 SQL',
          command: PREVIEW_CMD,
          arguments: [doc.uri, stmtLine],
        }),
      );
    }
    return lenses;
  }
}
