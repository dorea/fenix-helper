/**
 * Fenix Helper 扩展入口。
 * 激活条件：工作区存在 src/main/resources/fenix 目录下的 XML。
 *
 * 性能约定：激活路径上**只**做 fenix XML 索引（定向 glob，百级文件）。
 * 不要在这里全量扫描 src/main/java —— 那会占满 VS Code 的文件搜索服务，
 * 实测会让其它扩展的 workspaceContains 探测超时（java-module-manager 因此不激活）。
 */

import * as vscode from 'vscode';
import { FenixIndex, XML_SELECTOR, looksLikeFenixXml, isFenixXmlDoc, fqnFromUri } from './fenixIndex';
import {
  XmlToFenixDefinitionProvider,
  FenixCodeLensProvider,
  GOTO_DAO_CMD,
  GOTO_XML_CMD,
  gotoDaoMethodHandler,
  gotoXmlStatementHandler,
} from './navigation';
import {
  FenixTagCompletionProvider,
  FenixAttrCompletionProvider,
  FenixParamCompletionProvider,
} from './completion';
import { FenixDiagnostics } from './diagnostics';
import { GenerateStatementActionProvider } from './codeActions';
import { FenixTreeProvider, OPEN_STATEMENT_CMD } from './fenixTree';
import { SqlPreviewManager, PREVIEW_CMD } from './preview';
import { JavaFenixCodeLensProvider } from './javaLenses';
import { sanitizeFileName } from './naming';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const index = new FenixIndex();
  const diagnostics = new FenixDiagnostics(index);
  context.subscriptions.push(diagnostics);
  const preview = new SqlPreviewManager(index);
  context.subscriptions.push(preview);

  // ---- 索引构建（仅 fenix XML） ----
  await index.build();

  // 注册到所有 XML（fenix 目录名可自定义），内部用内容判定筛出 fenix 文件
  const xmlSelector = XML_SELECTOR;
  const javaSelector = { language: 'java', scheme: 'file' };

  // ---- 跳转 + CodeLens + gutter ----
  const javaLenses = new JavaFenixCodeLensProvider(index);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(xmlSelector, new XmlToFenixDefinitionProvider(index)),
    vscode.languages.registerCodeLensProvider(xmlSelector, new FenixCodeLensProvider(index)),
    vscode.languages.registerCodeLensProvider(javaSelector, javaLenses),
    javaLenses,
    vscode.commands.registerCommand(GOTO_DAO_CMD, gotoDaoMethodHandler),
    vscode.commands.registerCommand(GOTO_XML_CMD, (uri: vscode.Uri, line: number) =>
      gotoXmlStatementHandler(index, uri, line),
    ),
    vscode.commands.registerCommand('fenixHelper.explainMissing', async (method: string) => {
      await vscode.window.showWarningMessage(
        `Fenix: 方法「${method}」在 fenix XML 中找不到同名语句。` +
          '可用命令面板执行「Fenix: New Fenix XML file」，或在方法上按 Alt+Enter 使用快速修复生成。',
      );
    }),
    vscode.commands.registerCommand(PREVIEW_CMD, async (uri?: vscode.Uri, line?: number) => {
      await preview.open(uri, line);
    }),
  );

  // ---- 补全 ----
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(xmlSelector, new FenixTagCompletionProvider(), '<'),
    vscode.languages.registerCompletionItemProvider(xmlSelector, new FenixAttrCompletionProvider(), ' '),
    vscode.languages.registerCompletionItemProvider(
      xmlSelector,
      new FenixParamCompletionProvider(index),
      '{',
      '.',
      '#',
    ),
  );

  // ---- Code Action ----
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      javaSelector,
      new GenerateStatementActionProvider(index),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  // ---- 大纲树 ----
  const tree = new FenixTreeProvider(index);
  const treeView = vscode.window.createTreeView('fenixExplorer', { treeDataProvider: tree });
  context.subscriptions.push(
    treeView,
    tree,
    vscode.commands.registerCommand('fenixHelper.refreshTree', () => {
      void index.build();
    }),
    vscode.commands.registerCommand('fenixHelper.filterTree', async () => {
      const f = await vscode.window.showInputBox({ prompt: '过滤（模块 / 文件 / 语句 id）', value: '' });
      if (f !== undefined) {
        tree.setFilter(f);
      }
    }),
    vscode.commands.registerCommand(OPEN_STATEMENT_CMD, async (uri: vscode.Uri, line: number) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      const maxLine = doc.lineCount - 1;
      const target = new vscode.Range(Math.min(line, maxLine), 0, Math.min(line, maxLine), 0);
      await vscode.window.showTextDocument(doc, { selection: target });
    }),
  );

  // ---- 诊断 ----
  const recheck = (doc: vscode.TextDocument) => {
    void diagnostics.checkDocument(doc).catch((e: unknown) => {
      console.error('[fenix-helper] diagnostics failed', e);
    });
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(recheck),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // Java 保存：只失效这个文件的缓存并复查，不做全量重建
      const fqn = fqnFromUri(doc.uri);
      if (fqn) {
        index.invalidateJava(fqn);
      }
      recheck(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        recheck(e.document);
      }
    }),
  );
  await diagnostics.checkAllOpen();

  // ---- 监听：只监听 fenix XML（不建 src/main/java 全量 watcher） ----
  // 监听范围必须覆盖「任意位置的 fenix XML」。这里监听 XML 与资源目录，
  // 回调里用内容判定（<fenixs）决定是否纳入索引，避免依赖固定目录名。
  const xmlWatchers = [
    // 资源目录下的 XML（fenix 的 xml-locations 指向 resources 下的某个目录）
    vscode.workspace.createFileSystemWatcher('**/src/main/resources/**/*.xml'),
    // 目录名以 fenix 结尾的情况（fenix / md-fenix / base-fenix …），以及不在 resources 下的
    vscode.workspace.createFileSystemWatcher('**/*fenix/**/*.xml'),
  ];
  context.subscriptions.push(
    ...xmlWatchers,
    ...xmlWatchers.map((w) =>
      w.onDidChange(async (uri) => {
        if (!index.xmlUris.has(uri.toString())) {
          return; // 不是已识别的 fenix 文件，忽略
        }
        try {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          index.removeXml(uri);
          index.addXml(uri, text);
        } catch {
          index.removeXml(uri);
        }
        await diagnostics.checkAllOpen();
      }),
    ),
    ...xmlWatchers.map((w) =>
      w.onDidCreate(async (uri) => {
        try {
          const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
          if (!looksLikeFenixXml(text.slice(0, 2048))) {
            return;
          }
          index.addXml(uri, text);
        } catch {
          /* ignore */
        }
        await diagnostics.checkAllOpen();
      }),
    ),
    ...xmlWatchers.map((w) =>
      w.onDidDelete(async (uri) => {
        if (!index.xmlUris.has(uri.toString())) {
          return;
        }
        index.removeXml(uri);
        diagnostics.clear(uri);
        await diagnostics.checkAllOpen();
      }),
    ),
  );

  // ---- 命令：新建 fenix XML ----
  context.subscriptions.push(
    vscode.commands.registerCommand('fenixHelper.newXml', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'XML 文件名（含 .xml，一般与 Dao 同名）',
        value: 'NewDao.xml',
      });
      if (!name) {
        return;
      }
      const safe = sanitizeFileName(name);
      const fileName = safe.endsWith('.xml') ? safe : safe + '.xml';

      // 目录候选来自已识别的 fenix 文件（位置不固定）
      const dirs = new Set<string>();
      for (const entry of index.xmlByNamespace.values()) {
        dirs.add(entry.uri.with({ path: entry.uri.path.slice(0, entry.uri.path.lastIndexOf('/')) }).toString());
      }
      let dir: vscode.Uri | undefined;
      if (dirs.size > 0) {
        const list = [...dirs].map((d) => vscode.Uri.parse(d));
        const pick = await vscode.window.showQuickPick(
          list.map((d) => ({ label: d.path.split('/').slice(-3).join('/'), full: d })),
          { placeHolder: '选择 fenix XML 目录' },
        );
        dir = pick?.full ?? list[0];
      } else if (vscode.workspace.workspaceFolders?.length) {
        dir = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'src/main/resources/fenix');
      }
      if (!dir) {
        void vscode.window.showWarningMessage('Fenix: 找不到目标目录');
        return;
      }

      const ns = await vscode.window.showInputBox({
        prompt: 'namespace（Dao 接口全限定名）',
        value: '',
        validateInput: (v) => (v.trim() ? undefined : 'namespace 不能为空'),
      });
      if (!ns) {
        return;
      }

      const target = vscode.Uri.joinPath(dir, fileName);
      const skeleton =
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<fenixs namespace="${ns}">\n\n` +
        `    <fenix id="method1">\n` +
        `        SELECT\n            *\n        FROM\n            t_table t\n        WHERE\n            1 = 1\n` +
        `        <andEqual field="t.col" value="p.col" match="p.col != empty"/>\n` +
        `    </fenix>\n\n` +
        `</fenixs>\n`;
      try {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(skeleton));
        await vscode.window.showTextDocument(target);
      } catch (e) {
        void vscode.window.showErrorMessage(`Fenix: 写入失败 ${String(e)}`);
      }
    }),
  );
}

export function deactivate(): void {
  /* nothing */
}
