/**
 * 从 Spring 配置里解析 fenix 的 XML 位置（纯函数，无 vscode 依赖）。
 *
 * fenix 的 `fenix.xml-locations` 默认是 `fenix`，但可以配置成任意目录名
 * （例如 `md-fenix`、`base-fenix`），也可以在 mybatis 式的 properties 里配置。
 */

/** 规范化一行配置里的路径片段 */
export function cleanLocation(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^classpath\*?:?/, '')
    .replace(/^\/+/, '')
    .replace(/\/\*\*.*$/, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * 从一份 application 配置文本中提取 xml-locations。
 * 支持：
 *   properties: fenix.xml-locations=fenix,md-fenix
 *   yml 内联:   xml-locations: fenix
 *   yml 列表:   xml-locations:\n  - fenix\n  - md-fenix
 */
export function parseXmlLocations(text: string): string[] {
  const out = new Set<string>();

  // properties 形式
  for (const m of text.matchAll(/^[ \t]*fenix\.xml-locations[ \t]*[=:][ \t]*(.+)$/gm)) {
    for (const part of m[1].split(',')) {
      const v = cleanLocation(part);
      if (v) {
        out.add(v);
      }
    }
  }

  // yml 形式
  const ymlRe = /^[ \t-]*xml-locations[ \t]*:[ \t]*(.*)$/gm;
  let ym: RegExpExecArray | null;
  while ((ym = ymlRe.exec(text)) !== null) {
    const inline = ym[1].trim();
    if (inline) {
      for (const part of inline.split(',')) {
        const v = cleanLocation(part);
        if (v) {
          out.add(v);
        }
      }
      continue;
    }
    // 列表项：后续的 "- xxx"
    const after = text.slice(ym.index + ym[0].length);
    for (const line of after.split(/\r?\n/)) {
      if (line.trim() === '') {
        continue;
      }
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (!item) {
        break; // 列表结束
      }
      const v = cleanLocation(item[1]);
      if (v) {
        out.add(v);
      }
    }
  }
  return [...out];
}

/** 把 xml-locations 转成查找用的 glob 列表 */
export function globsForLocations(locations: string[]): string[] {
  const globs: string[] = [];
  for (const loc of locations) {
    globs.push(`**/src/main/resources/${loc}/**/*.xml`);
    globs.push(`**/${loc}/**/*.xml`);
  }
  return globs;
}

/** 默认候选 glob（覆盖常见目录名，并用内容判定最终确认） */
export const DEFAULT_XML_GLOBS = [
  '**/src/main/resources/fenix/**/*.xml',
  '**/src/main/resources/*-fenix/**/*.xml',
  '**/fenix/**/*.xml',
  '**/*-fenix/**/*.xml',
];
