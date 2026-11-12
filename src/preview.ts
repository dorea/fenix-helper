/**
 * SQL 预览（webview）：
 *   表格化条件面板 —— 第一列勾选框（是否包含该条件）、第二列条件名称、第三列参数输入框。
 *   勾选 = 强制包含该条件；不勾 = 强制排除。输入值直接代入 SQL（命名参数 + 内联值两种视图）。
 *   支持一键复制生成好的 SQL。
 *
 * 关键点：面板是复用的，当前预览目标必须存在管理器字段里，
 * 消息处理器只读字段，绝不闭包捕获某次 open() 的局部变量。
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { FenixIndex } from './fenixIndex';
import { parseFenixDocument, renderStatement, RenderResult, RNode } from './sqlRenderer';
import { analyzeStatement, buildContext, inlineParams, CondItem } from './analyze';
import { lineAt } from './xmlParser';

export const PREVIEW_CMD = 'fenixHelper.previewSql';

interface PreviewTarget {
  uri: vscode.Uri;
  namespace: string;
  stmtId: string;
  node: RNode;
  key: string;
  conditions: CondItem[];
  freeParams: string[];
  /** key → { checked, value } */
  rows: Map<string, { checked: boolean; value: string }>;
}

export class SqlPreviewManager {
  private panel?: vscode.WebviewPanel;
  private current?: PreviewTarget;
  /** ns#id → 上次的输入（记住用户的填值） */
  private memory = new Map<string, Map<string, { checked: boolean; value: string }>>();

  constructor(private index: FenixIndex) {}

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  async open(uri?: vscode.Uri, line?: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    const targetLine = line ?? editor?.selection.active.line ?? 0;
    if (!targetUri) {
      void vscode.window.showWarningMessage('Fenix: 请先打开一个 fenix XML 文件');
      return;
    }

    let text: string;
    try {
      const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === targetUri.toString());
      text = openDoc ? openDoc.getText() : (await vscode.workspace.openTextDocument(targetUri)).getText();
    } catch (e) {
      void vscode.window.showErrorMessage(`Fenix: 读取文件失败（${String(e)}）`);
      return;
    }

    const fd = parseFenixDocument(text);
    if (!fd.namespace || fd.statements.length === 0) {
      void vscode.window.showWarningMessage('Fenix: 该文件没有可预览的 fenix 语句');
      return;
    }

    let stmt = fd.statements.find((s) => lineAt(text, s.start) === targetLine);
    if (!stmt) {
      if (fd.statements.length === 1) {
        stmt = fd.statements[0];
      } else {
        const pick = await vscode.window.showQuickPick(
          fd.statements.map((s) => ({ label: s.id, stmt: s })),
          { placeHolder: '选择要预览的语句' },
        );
        if (!pick) {
          return;
        }
        stmt = pick.stmt;
      }
    }

    const key = `${fd.namespace}#${stmt.id}`;
    const analysis = analyzeStatement(stmt.node);

    // 复用上次填值；首次打开时，带条件的行默认勾选
    const remembered = this.memory.get(key);
    const rows = new Map<string, { checked: boolean; value: string }>();
    for (const c of analysis.conditions) {
      const prev = remembered?.get(c.key);
      rows.set(c.key, {
        checked: prev ? prev.checked : true,
        value: prev ? prev.value : '',
      });
    }
    for (const p of analysis.freeParams) {
      const prev = remembered?.get(`param:${p}`);
      rows.set(`param:${p}`, { checked: prev ? prev.checked : true, value: prev ? prev.value : '' });
    }

    this.current = {
      uri: targetUri,
      namespace: fd.namespace,
      stmtId: stmt.id,
      node: stmt.node,
      key,
      conditions: analysis.conditions,
      freeParams: analysis.freeParams,
      rows,
    };

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'fenixPreview',
        'Fenix SQL 预览',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
      });
      this.panel.webview.onDidReceiveMessage(async (m: PreviewMessage) => {
        const target = this.current;
        if (!target) {
          return;
        }
        if (m.type === 'ready' || m.type === 'render') {
          await this.handleRender(target, m);
          return;
        }
        if (m.type === 'copy' && typeof m.sql === 'string') {
          await vscode.env.clipboard.writeText(m.sql);
          void vscode.window.setStatusBarMessage('Fenix: SQL 已复制到剪贴板', 2500);
        }
      });
    } else {
      this.panel.reveal();
    }

    this.panel.title = `Fenix SQL 预览 — ${stmt.id}`;
    this.panel.webview.html = this.html(this.current);
  }

  private async handleRender(target: PreviewTarget, m: PreviewMessage): Promise<void> {
    // 同步 UI 状态
    if (m.rows) {
      for (const r of m.rows) {
        const cur = target.rows.get(r.key);
        if (cur) {
          cur.checked = r.checked;
          cur.value = r.value;
        }
      }
      this.memory.set(target.key, target.rows);
    }

    const result = await this.render(target);
    void this.panel?.webview.postMessage({ type: 'result', ...result });
  }

  private async render(target: PreviewTarget): Promise<RenderResult & { inlined: string }> {
    // 1) 由表格输入构建渲染上下文
    const values: Record<string, string> = {};
    for (const [rowKey, row] of target.rows) {
      if (!row.checked) {
        continue;
      }
      if (rowKey.startsWith('param:')) {
        values[rowKey.slice('param:'.length)] = row.value;
      }
    }
    // 条件行里的输入框（value="qv.plant"）也进上下文
    for (const c of target.conditions) {
      const row = target.rows.get(c.key);
      if (!row) {
        continue;
      }
      for (const input of c.inputs) {
        // 该条件的输入：若用户填了值就用，否则保持空
        values[input] = row.value;
      }
      // 条件表达式里引用的参数（如 match="qv.plant != empty"）也需要值
      for (const p of c.params) {
        if (!(p in values) && row.value !== '') {
          values[p] = row.value;
        }
      }
    }
    const ctx = buildContext(values);

    // 2) 勾选框 → 条件覆盖
    const overrides = new Map<string, boolean>();
    for (const c of target.conditions) {
      const row = target.rows.get(c.key);
      if (row) {
        overrides.set(c.key, row.checked);
      }
    }

    // 3) 渲染
    const docCache = new Map<string, ReturnType<typeof parseFenixDocument> | null>();
    const loadDoc = async (ns: string) => {
      if (docCache.has(ns)) {
        return docCache.get(ns)!;
      }
      const entry = this.index.xmlByNamespace.get(ns);
      let doc: ReturnType<typeof parseFenixDocument> | null = null;
      if (entry) {
        try {
          const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === entry.uri.toString());
          const content = openDoc
            ? openDoc.getText()
            : new TextDecoder().decode(await vscode.workspace.fs.readFile(entry.uri));
          doc = parseFenixDocument(content);
        } catch {
          doc = null;
        }
      }
      docCache.set(ns, doc);
      return doc;
    };
    for (const ns of this.index.xmlByNamespace.keys()) {
      await loadDoc(ns);
    }

    const deps = {
      currentNamespace: target.namespace,
      overrides,
      resolveImport: (ns: string, fenixId: string): RNode | null => {
        const doc = docCache.get(ns);
        return doc?.statements.find((s) => s.id === fenixId)?.node ?? null;
      },
    };
    const result = renderStatement(target.node, ctx, deps);
    return { ...result, inlined: inlineParams(result.sql, result.params) };
  }

  private html(target: PreviewTarget): string {
    const esc = (s: string): string =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const nonce = crypto.randomBytes(16).toString('base64');

    // 条件行 + 自由参数行
    const rowsHtml: string[] = [];
    for (const c of target.conditions) {
      const row = target.rows.get(c.key) ?? { checked: true, value: '' };
      rowsHtml.push(
        `<tr data-key="${esc(c.key)}" class="cond">` +
          `<td class="ck"><input type="checkbox" ${row.checked ? 'checked' : ''} data-role="checked"></td>` +
          `<td class="name" title="${esc(c.cond ?? '')}">${esc(c.label)}</td>` +
          `<td class="val"><input type="text" placeholder="${esc(c.inputs[0] ?? '')}" value="${esc(row.value)}" data-role="value" data-input="${esc(c.inputs[0] ?? '')}"></td>` +
          `</tr>`,
      );
    }
    for (const p of target.freeParams) {
      const key = `param:${p}`;
      const row = target.rows.get(key) ?? { checked: true, value: '' };
      rowsHtml.push(
        `<tr data-key="${esc(key)}" class="param">` +
          `<td class="ck"><input type="checkbox" ${row.checked ? 'checked' : ''} data-role="checked"></td>` +
          `<td class="name">#&123;${esc(p)}&#125;</td>` +
          `<td class="val"><input type="text" placeholder="${esc(p)}" value="${esc(row.value)}" data-role="value" data-input="${esc(p)}"></td>` +
          `</tr>`,
      );
    }
    if (rowsHtml.length === 0) {
      rowsHtml.push('<tr><td colspan="3" class="muted">该语句没有动态条件</td></tr>');
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${esc(target.key)}</title>
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); padding: 10px 12px; color: var(--vscode-editor-foreground); }
  h3 { margin: 10px 0 6px; font-size: 12px; font-weight: 600; opacity: .75; letter-spacing: .04em; text-transform: uppercase; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c); padding: 4px 6px; text-align: left; vertical-align: middle; }
  th { font-weight: 600; opacity: .8; border-bottom-width: 1px; }
  td.ck { width: 28px; text-align: center; }
  td.ck input { cursor: pointer; }
  td.name { font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
  tr.param td.name { color: var(--vscode-descriptionForeground); }
  td.val input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #3c3c3c); padding: 3px 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  td.val input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin: 6px 0 2px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
  label.toggle { font-size: 12px; opacity: .85; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
  pre.sql { background: var(--vscode-textCodeBlock-background); padding: 10px; font-size: 13px; white-space: pre-wrap; word-break: break-all; border-radius: 4px; margin: 0; font-family: var(--vscode-editor-font-family); }
  .kw { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); font-weight: 600; }
  .param { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .lit { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); font-size: 12px; }
  .muted { opacity: .55; }
  .hint { font-size: 11px; opacity: .55; margin-top: 4px; }
</style>
</head>
<body>
  <h3>条件（勾选 = 生成该条件）</h3>
  <table id="rows">
    <thead><tr><th class="ck">✓</th><th>条件 / 字段</th><th>参数值</th></tr></thead>
    <tbody>${rowsHtml.join('')}</tbody>
  </table>
  <div class="hint">在第三列填值即可替换 SQL 中的参数；取消勾选可强制去掉该条件。</div>

  <h3>生成的 SQL</h3>
  <div class="toolbar">
    <button id="copy">复制 SQL</button>
    <label class="toggle"><input type="checkbox" id="inline" checked> 直接内联参数值</label>
  </div>
  <pre class="sql" id="sql">渲染中…</pre>
  <div id="warnings"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { inlined: '', raw: '' };
    const pending = {};

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const KW = /\\b(SELECT|FROM|WHERE|AND|OR|LEFT|RIGHT|INNER|OUTER|JOIN|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|UNION|ALL|DISTINCT|AS|IS|NOT|NULL|LIKE|BETWEEN|IN|EXISTS|CASE|WHEN|THEN|ELSE|END|COUNT|SUM|AVG|MIN|MAX|DELETE|UPDATE|SET|INSERT|INTO|VALUES|ASC|DESC|TOP|WITH)\\b/gi;
    function hl(sql) {
      let s = esc(sql);
      s = s.replace(/('[^']*')/g, '<span class="lit">$1</span>');
      s = s.replace(/(:[A-Za-z_][\\w]*)/g, '<span class="param">$1</span>');
      s = s.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g, '<span class="lit">$1</span>');
      return s.replace(KW, (m) => '<span class="kw">' + m + '</span>');
    }
    function paint() {
      const inline = document.getElementById('inline').checked;
      const sql = inline ? state.inlined : state.raw;
      document.getElementById('sql').innerHTML = sql ? hl(sql) : '<span class="muted">(空)</span>';
      document.getElementById('copy').textContent = inline ? '复制 SQL（含值）' : '复制 SQL（命名参数）';
    }
    function collect() {
      const rows = [];
      document.querySelectorAll('#rows tbody tr[data-key]').forEach((tr) => {
        const ck = tr.querySelector('input[data-role="checked"]');
        const val = tr.querySelector('input[data-role="value"]');
        rows.push({ key: tr.dataset.key, checked: !!(ck && ck.checked), value: val ? val.value : '' });
      });
      return rows;
    }
    function render(immediate) {
      const run = () => vscode.postMessage({ type: 'render', rows: collect() });
      if (immediate) { run(); return; }
      clearTimeout(pending.t);
      pending.t = setTimeout(run, 300);
    }
    document.getElementById('rows').addEventListener('input', () => render(false));
    document.getElementById('rows').addEventListener('change', () => render(false));
    document.getElementById('inline').addEventListener('change', paint);
    document.getElementById('copy').addEventListener('click', () => {
      const inline = document.getElementById('inline').checked;
      vscode.postMessage({ type: 'copy', sql: inline ? state.inlined : state.raw });
    });
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type !== 'result') return;
      state.inlined = m.inlined || '';
      state.raw = m.sql || '';
      paint();
      const w = m.warnings || [];
      document.getElementById('warnings').innerHTML = w.map((x) => '<div class="warn">⚠ ' + esc(x) + '</div>').join('');
    });
    vscode.postMessage({ type: 'ready', rows: collect() });
  </script>
</body>
</html>`;
  }
}

interface PreviewMessage {
  type?: 'ready' | 'render' | 'copy';
  rows?: Array<{ key: string; checked: boolean; value: string }>;
  sql?: string;
}
