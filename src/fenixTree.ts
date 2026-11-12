/**
 * FENIX 大纲树：模块 → fenix XML 文件 → 语句，支持关键字过滤，点击跳转。
 */

import * as vscode from 'vscode';
import { FenixIndex } from './fenixIndex';

export const OPEN_STATEMENT_CMD = 'fenixHelper.openStatement';

interface StmtEntry {
  uri: vscode.Uri;
  line: number;
  id: string;
}

export class FenixTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private filter = '';
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private readonly indexSub: vscode.Disposable;

  constructor(private index: FenixIndex) {
    this.indexSub = index.onDidChange(() => this.refresh());
  }

  dispose(): void {
    this.indexSub.dispose();
    this._onDidChange.dispose();
  }

  setFilter(f: string): void {
    this.filter = f.trim().toLowerCase();
    this.refresh();
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    const groups = new Map<string, Array<{ file: string; uri: vscode.Uri; stmts: StmtEntry[] }>>();

    for (const [ns, entry] of this.index.xmlByNamespace) {
      const module = moduleOf(entry.uri);
      if (!groups.has(module)) {
        groups.set(module, []);
      }
      groups.get(module)!.push({
        file: entry.uri.path.split('/').pop() ?? ns,
        uri: entry.uri,
        stmts: entry.statements.map((s) => ({ uri: entry.uri, line: s.line, id: s.id })),
      });
    }

    if (!element) {
      // 顶层：模块
      const mods = [...groups.keys()].sort();
      return mods
        .filter((m) => !this.filter || this.moduleMatches(groups.get(m)!, this.filter))
        .map((m) => {
          const item = new vscode.TreeItem(m, vscode.TreeItemCollapsibleState.Collapsed);
          item.contextValue = 'module';
          item.iconPath = new vscode.ThemeIcon('folder-library');
          item.description = `${groups.get(m)!.length} 个 XML`;
          return item;
        });
    }

    if (element.contextValue === 'module') {
      const list = groups.get(element.label as string) ?? [];
      return list
        .filter((f) => !this.filter || f.file.toLowerCase().includes(this.filter) ||
          f.stmts.some((s) => s.id.toLowerCase().includes(this.filter)))
        .map((f) => {
          const item = new vscode.TreeItem(f.file, vscode.TreeItemCollapsibleState.Collapsed);
          item.iconPath = new vscode.ThemeIcon('file-code');
          item.description = `${f.stmts.length} 条语句`;
          item.contextValue = 'file';
          item.resourceUri = f.uri;
          item.command = {
            command: OPEN_STATEMENT_CMD,
            title: '打开',
            arguments: [f.uri, 0],
          };
          return item;
        });
    }

    if (element.contextValue === 'file' && element.resourceUri) {
      const all: StmtEntry[] = [];
      for (const g of groups.values()) {
        for (const f of g) {
          if (f.uri.toString() === element.resourceUri.toString()) {
            all.push(...f.stmts);
          }
        }
      }
      return all
        .filter((s) => !this.filter || s.id.toLowerCase().includes(this.filter) ||
          element.label!.toString().toLowerCase().includes(this.filter))
        .sort((a, b) => a.line - b.line)
        .map((s) => {
          const item = new vscode.TreeItem(s.id);
          item.iconPath = new vscode.ThemeIcon('symbol-method');
          item.contextValue = 'stmt';
          item.command = {
            command: OPEN_STATEMENT_CMD,
            title: '跳转',
            arguments: [s.uri, s.line],
          };
          return item;
        });
    }
    return [];
  }

  private moduleMatches(list: Array<{ file: string; stmts: StmtEntry[] }>, filter: string): boolean {
    return list.some(
      (f) => f.file.toLowerCase().includes(filter) || f.stmts.some((s) => s.id.toLowerCase().includes(filter)),
    );
  }
}

/** 模块名：fenix XML 路径里 src/main/resources 之前的部分 */
function moduleOf(uri: vscode.Uri): string {
  const raw = uri.fsPath.replace(/\\/g, '/');
  const idx = raw.lastIndexOf('/src/main/resources/fenix');
  if (idx < 0) {
    return '(其他)';
  }
  const before = raw.slice(0, idx);
  const segs = before.split('/').filter(Boolean);
  return segs[segs.length - 1] ?? '(其他)';
}
