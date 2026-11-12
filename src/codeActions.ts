/**
 * Code Action：
 *  - Java：@QueryFenix 方法缺 XML 语句 → 「生成 fenix XML 语句」
 *    （有同名 namespace 的 XML → 在 </fenixs> 前插入；否则新建 XxxDao.xml）
 */

import * as vscode from 'vscode';
import { FenixIndex, fqnFromUri } from './fenixIndex';
import { parseDaoFile } from './javaScanner';
import { lineAt, lineStartOffset } from './xmlParser';

export class GenerateStatementActionProvider implements vscode.CodeActionProvider {
  constructor(private index: FenixIndex) {}

  async provideCodeActions(doc: vscode.TextDocument, range: vscode.Range):
    Promise<vscode.CodeAction[]> {
    if (doc.languageId !== 'java') {
      return [];
    }
    const text = doc.getText();
    const fqn = fqnFromUri(doc.uri);
    if (!fqn) {
      return [];
    }
    const dao = parseDaoFile(text);
    const actions: vscode.CodeAction[] = [];
    const startOff = doc.offsetAt(range.start);
    const endOff = doc.offsetAt(range.end);

    for (const m of dao.methods) {
      const overlaps = startOff <= m.endOffset + 1 && endOff >= m.annotationOffset;
      if (!overlaps) {
        continue;
      }
      if (this.index.hasStatementFor(fqn, m)) {
        continue;
      }
      // 非标准源码布局（无 /src/main/java/）无法推导资源目录，不提供无效的快速修复
      if (!doc.uri.fsPath.replace(/\\/g, '/').includes('/src/main/java/')) {
        continue;
      }
      const target = resolveTarget(fqn, m);
      const action = new vscode.CodeAction(
        `Fenix: 生成 XML 语句「${target.id}」`,
        vscode.CodeActionKind.QuickFix,
      );
      action.edit = await this.buildEdit(doc.uri, target.namespace, target.id);
      action.diagnostics = [];
      actions.push(action);
    }
    return actions;
  }

  private async buildEdit(javaUri: vscode.Uri, fqn: string, methodId: string):
    Promise<vscode.WorkspaceEdit> {
    const edit = new vscode.WorkspaceEdit();
    const existing = this.index.xmlByNamespace.get(fqn);
    const shortName = fqn.split('.').pop() ?? 'Dao';

    if (existing) {
      // 已有 XML：在 </fenixs> 前插入
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(existing.uri));
        const closeIdx = text.lastIndexOf('</fenixs>');
        const insertOffset = closeIdx >= 0 ? closeIdx : text.length;
        const line = lineAt(text, insertOffset);
        const col = insertOffset - lineStartOffset(text, insertOffset);
        const stmt = `\n    <fenix id="${methodId}">\n        SELECT\n            *\n        FROM\n            t_table t\n        WHERE\n            1 = 1\n    </fenix>\n`;
        edit.insert(existing.uri, new vscode.Position(line, col), stmt);
        return edit;
      } catch {
        // 读失败则走新建
      }
    }

    // 新建 XML：src/main/java → src/main/resources/fenix
    const raw = javaUri.fsPath.replace(/\\/g, '/');
    const marker = '/src/main/java/';
    const idx = raw.lastIndexOf(marker);
    const base = idx >= 0 ? raw.slice(0, idx) + '/src/main/resources/fenix' : null;
    if (!base) {
      return edit;
    }
    const xmlUri = vscode.Uri.file(`${base}/${shortName}.xml`);

    // 目标文件可能已存在（另一个包的同名 Dao，或尚未进索引）：此时不能 createFile(overwrite:false)
    const existingOnDisk = await fileExists(xmlUri);
    if (existingOnDisk) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(xmlUri));
        const closeIdx = text.lastIndexOf('</fenixs>');
        const insertOffset = closeIdx >= 0 ? closeIdx : text.length;
        const line = lineAt(text, insertOffset);
        const col = insertOffset - lineStartOffset(text, insertOffset);
        const stmt = `
    <fenix id="${methodId}">
        SELECT
            *
        FROM
            t_table t
        WHERE
            1 = 1
    </fenix>
`;
        edit.insert(xmlUri, new vscode.Position(line, col), stmt);
        return edit;
      } catch {
        // 落到下面重新创建
      }
    }
    const skeleton =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<fenixs namespace="${fqn}">\n\n` +
      `    <fenix id="${methodId}">\n` +
      `        SELECT\n            *\n        FROM\n            t_table t\n        WHERE\n            1 = 1\n` +
      `        <andEqual field="t.col" value="p.col" match="p.col != empty"/>\n` +
      `    </fenix>\n\n` +
      `</fenixs>\n`;
    edit.createFile(xmlUri, { overwrite: false });
    edit.insert(xmlUri, new vscode.Position(0, 0), skeleton);
    return edit;
  }
}

/** @QueryFenix 的目标 namespace/id（值形式按 ShortName 解析到对应 Dao） */
function resolveTarget(fqn: string, m: { name: string; queryFenixValue: string | null }): {
  namespace: string;
  id: string;
} {
  if (!m.queryFenixValue) {
    return { namespace: fqn, id: m.name };
  }
  const dot = m.queryFenixValue.indexOf('.');
  if (dot <= 0) {
    return { namespace: fqn, id: m.name };
  }
  const shortClassName = m.queryFenixValue.slice(0, dot);
  const fenixId = m.queryFenixValue.slice(dot + 1);
  // 优先当前 Dao 自身匹配，否则用同包下的同名类
  const namespace = fqn.endsWith('.' + shortClassName)
    ? fqn
    : (fqn.includes('.') ? fqn.slice(0, fqn.lastIndexOf('.') + 1) + shortClassName : fqn);
  return { namespace, id: fenixId };
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
