/**
 * 工作区索引：fenix XML 语句 + Java 文件的按需解析。
 *
 * 关键设计一（XML 位置不固定）：
 *   fenix 的 `fenix.xml-locations` 是可配置的，XML 目录名可以是
 *   `fenix`、`md-fenix`、`base-fenix`、任意自定义名，也可能不在 `resources` 下。
 *   因此**不按固定路径匹配**，改为：
 *     1. 汇总候选 glob（默认 + 用户设置 + 从 application*.yml/properties 读到的 xml-locations）
 *     2. 逐个 findFiles，**用内容判定**（文件头出现 `<fenixs`）确认为 fenix 文件
 *
 * 关键设计二（性能）：
 *   不全量扫描 src/main/java（会占满 VS Code 文件搜索服务，令其它扩展的
 *   workspaceContains 探测超时）。Java 侧按 FQN 定向查找 + 正负缓存。
 */

import * as vscode from 'vscode';
import { parseFenixXml, FenixXmlInfo } from './xmlParser';
import { parseDaoFile, DaoInfo, parseVoFile, VoInfo, resolveFqn, splitQueryFenixValue } from './javaScanner';
import { DEFAULT_XML_GLOBS, globsForLocations, parseXmlLocations } from './xmlLocations';

const EXCLUDE = '**/{node_modules,target,bin,.history,out,dist,build}/**';

/** 任意 XML 都可能是 fenix 文件（目录名不固定），providers 注册在这个 selector 上，内部再判定 */
export const XML_SELECTOR: vscode.DocumentFilter = { language: 'xml', scheme: 'file' };

/** 判定 fenix 文件的内容特征（只看文件头，避免大文件全量扫描） */
export function looksLikeFenixXml(head: string): boolean {
  return /<fenixs\b/.test(head);
}

/** 该文档是否是 fenix XML（内容判定，与目录位置无关） */
export function isFenixXmlDoc(doc: vscode.TextDocument): boolean {
  if (doc.languageId !== 'xml' || doc.uri.scheme !== 'file') {
    return false;
  }
  const head = doc.getText(new vscode.Range(0, 0, Math.min(doc.lineCount - 1, 60), 0));
  return looksLikeFenixXml(head);
}

export class FenixIndex {
  /** 索引变更事件（大纲树等监听） */
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** namespace → 文件信息 */
  readonly xmlByNamespace = new Map<string, FenixXmlInfo & { uri: vscode.Uri }>();
  /** key = `${namespace}#${id}` */
  readonly statements = new Map<string, FenixXmlInfo & { uri: vscode.Uri; id: string; line: number }>();

  /** 已识别的 fenix XML 文件（含内容未变但未解析的） */
  readonly xmlUris = new Set<string>();

  private javaUriCache = new Map<string, vscode.Uri | null>();
  private daoCache = new Map<string, { mtime: number; dao: DaoInfo | null }>();
  private voCache = new Map<string, { mtime: number; vo: VoInfo | null }>();

  /** 索引所有 fenix XML（位置由配置/内容决定） */
  async build(): Promise<void> {
    this.xmlByNamespace.clear();
    this.statements.clear();
    this.xmlUris.clear();

    for (const uri of await this.discoverXmlUris()) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        if (!looksLikeFenixXml(text.slice(0, 2048))) {
          continue;
        }
        this.indexXml(uri, text);
      } catch {
        // 读不了的文件跳过
      }
    }
    this._onDidChange.fire();
  }

  /** 汇总候选 glob 并逐个查找（结果按 uri 去重） */
  async discoverXmlUris(): Promise<vscode.Uri[]> {
    const globs = new Set<string>(DEFAULT_XML_GLOBS);

    // 用户显式配置
    const configured = vscode.workspace.getConfiguration('fenixHelper').get<string[]>('xmlGlobs', []);
    for (const g of configured) {
      if (g && g.trim()) {
        globs.add(g.trim());
      }
    }

    // 从 fenix.xml-locations 推导（可能是 md-fenix、base-fenix 等自定义目录）
    for (const g of globsForLocations(await this.readXmlLocations())) {
      globs.add(g);
    }

    const found = new Map<string, vscode.Uri>();
    for (const glob of globs) {
      try {
        for (const uri of await vscode.workspace.findFiles(glob, EXCLUDE, 2000)) {
          found.set(uri.toString(), uri);
        }
      } catch {
        // 忽略非法 glob
      }
    }
    return [...found.values()];
  }

  /** 从 application*.yml / yaml / properties 读取 fenix.xml-locations */
  async readXmlLocations(): Promise<string[]> {
    let files: vscode.Uri[] = [];
    try {
      files = await vscode.workspace.findFiles('**/application*.{yml,yaml,properties}', EXCLUDE, 60);
    } catch {
      return [];
    }
    const found = new Set<string>();
    for (const uri of files) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        for (const loc of parseXmlLocations(text)) {
          found.add(loc);
        }
      } catch {
        /* ignore */
      }
    }
    return [...found];
  }

  /** 把一个 fenix XML 并入索引 */
  indexXml(uri: vscode.Uri, text: string): void {
    const info = parseFenixXml(text);
    const entry = { ...info, uri };
    this.xmlUris.add(uri.toString());
    if (info.namespace) {
      this.xmlByNamespace.set(info.namespace, entry);
      for (const st of info.statements) {
        this.statements.set(`${info.namespace}#${st.id}`, { ...entry, id: st.id, line: st.line });
      }
      this._onDidChange.fire();
    }
  }

  /** 兼容旧调用名 */
  addXml(uri: vscode.Uri, text: string): void {
    this.indexXml(uri, text);
  }

  removeXml(uri: vscode.Uri): void {
    let removed = false;
    this.xmlUris.delete(uri.toString());
    for (const [ns, entry] of [...this.xmlByNamespace]) {
      if (entry.uri.toString() === uri.toString()) {
        for (const id of this.statements.keys()) {
          if (id.startsWith(ns + '#')) {
            this.statements.delete(id);
          }
        }
        this.xmlByNamespace.delete(ns);
        removed = true;
      }
    }
    if (removed) {
      this._onDidChange.fire();
    }
  }

  /**
   * FQN → Java 文件 Uri（按需定向查找 + 缓存，含负缓存）。
   * 路径约定：<任意模块>/src/main/java/<包路径>/<类名>.java
   */
  async resolveJavaUri(fqn: string): Promise<vscode.Uri | null> {
    if (this.javaUriCache.has(fqn)) {
      return this.javaUriCache.get(fqn)!;
    }
    const parts = fqn.split('.');
    const simple = parts.pop();
    if (!simple) {
      return null;
    }
    const rel = parts.length ? parts.join('/') + '/' + simple + '.java' : simple + '.java';
    let found: vscode.Uri | null = null;
    try {
      const uris = await vscode.workspace.findFiles('**/src/main/java/' + rel, EXCLUDE, 5);
      found = uris[0] ?? null;
    } catch {
      found = null;
    }
    this.javaUriCache.set(fqn, found);
    return found;
  }

  /** 丢弃某个 FQN 的缓存（保存/新建/删除时调用） */
  invalidateJava(fqn?: string): void {
    if (fqn) {
      this.javaUriCache.delete(fqn);
      const simple = fqn.split('.').pop();
      for (const key of [...this.daoCache.keys()]) {
        if (simple && key.endsWith('/' + simple + '.java')) {
          this.daoCache.delete(key);
        }
      }
    } else {
      this.javaUriCache.clear();
      this.daoCache.clear();
      this.voCache.clear();
    }
  }

  /** 读 Dao 文件并解析（带 mtime 缓存）；找不到返回 null */
  async daoOf(namespace: string): Promise<DaoInfo | null> {
    return this.daoOfFqn(namespace);
  }

  async daoOfFqn(fqn: string): Promise<DaoInfo | null> {
    const uri = await this.resolveJavaUri(fqn);
    if (!uri) {
      return null;
    }
    return this.readAndParseDao(uri);
  }

  async readAndParseDao(uri: vscode.Uri): Promise<DaoInfo | null> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.daoCache.get(uri.toString());
      if (cached && cached.mtime === stat.mtime) {
        return cached.dao;
      }
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const dao = parseDaoFile(text);
      this.daoCache.set(uri.toString(), { mtime: stat.mtime, dao });
      return dao;
    } catch {
      return null;
    }
  }

  /** 读 VO 文件并解析（按 mtime 缓存；补全/诊断会高频调用同一批文件） */
  async readAndParseVo(uri: vscode.Uri): Promise<VoInfo | null> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const cached = this.voCache.get(uri.toString());
      if (cached && cached.mtime === stat.mtime) {
        return cached.vo;
      }
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const vo = parseVoFile(text);
      this.voCache.set(uri.toString(), { mtime: stat.mtime, vo });
      return vo;
    } catch {
      return null;
    }
  }

  /**
   * 解析参数类型的字段（沿 extends 链，最多 6 层）。
   * 每一层都用**该层文件自己的 package/import** 解析父类（跨包继承的关键）。
   */
  async voFieldsOf(typeSimple: string, dao: DaoInfo): Promise<string[]> {
    const fields: string[] = [];
    const seen = new Set<string>();
    let fqn = resolveFqn(typeSimple, dao);

    for (let depth = 0; depth < 6; depth++) {
      if (!fqn || seen.has(fqn)) {
        break;
      }
      seen.add(fqn);
      const uri = await this.resolveJavaUri(fqn);
      if (!uri) {
        break;
      }
      const vo = await this.readAndParseVo(uri);
      if (!vo) {
        break;
      }
      fields.push(...vo.fields);
      if (!vo.extendsSimple) {
        break;
      }
      fqn = resolveFqn(vo.extendsSimple, {
        pkg: vo.pkg,
        typeName: null,
        imports: vo.imports,
        methods: [],
      });
    }
    return [...new Set(fields)];
  }

  /**
   * 解析 @QueryFenix 的目标 XML 语句：
   *  - 空值形式：namespace = Dao FQN, id = 方法名
   *  - 值形式 "ShortName.methodId"：找 namespace 以 .ShortName 结尾且 id 匹配的语句
   */
  resolveQueryFenixTarget(daoFqn: string, method: { name: string; queryFenixValue: string | null }):
    { namespace: string; id: string } | null {
    if (!method.queryFenixValue) {
      const key = `${daoFqn}#${method.name}`;
      return this.statements.has(key) ? { namespace: daoFqn, id: method.name } : null;
    }
    const dot = method.queryFenixValue.indexOf('.');
    if (dot <= 0) {
      return null;
    }
    const shortName = method.queryFenixValue.slice(0, dot);
    const fenixId = method.queryFenixValue.slice(dot + 1);
    for (const ns of this.xmlByNamespace.keys()) {
      if (ns.endsWith('.' + shortName)) {
        const key = `${ns}#${fenixId}`;
        if (this.statements.has(key)) {
          return { namespace: ns, id: fenixId };
        }
      }
    }
    return null;
  }

  hasStatementFor(daoFqn: string, method: { name: string; queryFenixValue: string | null }): boolean {
    return this.resolveQueryFenixTarget(daoFqn, method) !== null;
  }
}

/** 规范化 xml-locations 里的路径片段 */
function cleanLocation(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^classpath\*?:?/, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/\*\*.*$/, '')
    .trim();
}

/** 从 java 文件 Uri 推导全限定类名（src/main/java 之后的路径） */
export function fqnFromUri(uri: vscode.Uri): string | null {
  const raw = uri.fsPath.replace(/\\/g, '/');
  const marker = '/src/main/java/';
  const idx = raw.lastIndexOf(marker);
  if (idx < 0) {
    return null;
  }
  const rel = raw.slice(idx + marker.length).replace(/\.java$/, '');
  return rel.split('/').join('.');
}

export { splitQueryFenixValue };
