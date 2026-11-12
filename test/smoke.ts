/** 冒烟脚本：把一批真实 fenix XML 逐个过渲染器（node out/smoke.mjs <文件…>） */
import * as fs from 'fs';
import { parseFenixDocument, renderStatement, RNode } from '../src/sqlRenderer';

const files = process.argv.slice(2);
let total = 0;
let ok = 0;
let warned = 0;
const docCache = new Map<string, ReturnType<typeof parseFenixDocument>>();

function docOf(f: string) {
  if (!docCache.has(f)) {
    docCache.set(f, parseFenixDocument(fs.readFileSync(f, 'utf8')));
  }
  return docCache.get(f)!;
}

function resolveImport(ns: string, id: string): RNode | null {
  for (const d of docCache.values()) {
    if (d.namespace === ns) {
      return d.statements.find((s) => s.id === id)?.node ?? null;
    }
  }
  return null;
}

for (const f of files) {
  const fd = docOf(f);
  const ns = fd.namespace ?? '(no ns)';
  for (const st of fd.statements) {
    total++;
    try {
      const deps = { currentNamespace: ns, resolveImport };
      const empty = renderStatement(st.node, { qv: {} }, deps);
      const full = renderStatement(st.node, { qv: { plant: 'P01', supp: 'S', env: 'E', status: 'X', start: '2026-01-01', end: '2026-12-31', queryValue: 'kw', needCount: 10 } }, deps);
      const warn = empty.warnings.length + full.warnings.length;
      warned += warn;
      ok++;
      console.log(`\n=== ${ns.split('.').pop()}#${st.id}${warn ? `  ⚠${warn}` : ''}`);
      if (empty.warnings.length) {
        console.log('  [empty.warn]', ...empty.warnings);
      }
      if (full.warnings.length) {
        console.log('  [full.warn ]', ...full.warnings);
      }
      console.log('  [empty]', empty.sql.slice(0, 160));
      console.log('  [full ]', full.sql.slice(0, 160));
    } catch (e) {
      console.log(`\n!!! ${ns.split('.').pop()}#${st.id} 渲染异常: ${String(e)}`);
    }
  }
}
console.log(`\n---- ${ok}/${total} statements rendered, warnings: ${warned}`);
