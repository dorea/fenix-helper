/**
 * Java 侧的 @QueryFenix 提示：
 *  1. CodeLens（可点击、带图标）：「→ 跳转到 XML 语句」/「生成 XML 语句」
 *  2. 行首 gutter 图标：视觉标识（VS Code 没有可点击 gutter API，点击走 CodeLens）
 */

import * as vscode from 'vscode';
import { FenixIndex, fqnFromUri } from './fenixIndex';
import { parseDaoFile } from './javaScanner';
import { GOTO_XML_CMD, parseNamespace } from './navigation';

export class JavaFenixCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private index: FenixIndex) {
    index.onDidChange(() => this._onDidChange.fire());
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (doc.languageId !== 'java') {
      return [];
    }
    const fqn = fqnFromUri(doc.uri);
    if (!fqn) {
      return [];
    }
    const dao = parseDaoFile(doc.getText());
    const lenses: vscode.CodeLens[] = [];
    for (const m of dao.methods) {
      const line = doc.positionAt(m.nameOffset).line;
      const range = new vscode.Range(line, 0, line, 0);
      const target = this.index.resolveQueryFenixTarget(fqn, m);
      if (target) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(go-to-file) 跳转到 XML：${target.id}`,
            tooltip: `${target.namespace}#${target.id}`,
            command: GOTO_XML_CMD,
            arguments: [doc.uri, line],
          }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(warning) 缺少对应的 XML 语句',
            tooltip: '点击查看提示',
            command: 'fenixHelper.explainMissing',
            arguments: [m.name],
          }),
        );
      }
    }
    return lenses;
  }
}
