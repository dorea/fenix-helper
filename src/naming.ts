/**
 * 纯工具函数（无 vscode 依赖，可被 node 直测）。
 */

/** 文件名净化：去掉路径分隔符与上跳，避免写到 fenix 目录之外 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '_')
    .trim();
}
