/**
 * 补全：
 *  1. 标签补全：'<' 触发（fenix.xsd 全量标签 + snippet）
 *  2. 属性补全：标签内空格触发（按 xsd 属性表过滤已输入项）
 *  3. 参数补全：#{ / @if{ / match 等属性值里 → @Param 名 / VO 字段 两级
 */

import * as vscode from 'vscode';
import { FenixIndex, isFenixXmlDoc } from './fenixIndex';
import { FENIX_TAGS, TAG_BY_NAME, PARAM_VALUE_ATTRS } from './xsdData';
import { findEnclosingTag, findEnclosingStatementId, inBracedExpression } from './xmlParser';
import { parseNamespace } from './navigation';

export class FenixTagCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position):
    vscode.CompletionItem[] | undefined {
    if (!isFenixXmlDoc(doc)) {
      return undefined;
    }
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    // 光标前必须是 '<'（或 '</'）之后
    const before = text.slice(Math.max(0, offset - 2), offset);
    // 闭标签 '&lt;/' 场景不提供开始标签片段（片段本身以 '<' 开头，会插出 &lt;&lt;tag）
    if (!before.endsWith('<')) {
      return undefined;
    }
    return FENIX_TAGS.map((t) => {
      const item = new vscode.CompletionItem(t.name, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(t.snippet);
      item.detail = t.detail ?? 'fenix 标签';
      item.documentation = new vscode.MarkdownString(
        `属性：${t.attrs.map((a) => (a.required ? `**${a.name}**` : a.name)).join(', ')}`,
      );
      return item;
    });
  }
}

export class FenixAttrCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position):
    vscode.CompletionItem[] | undefined {
    if (!isFenixXmlDoc(doc)) {
      return undefined;
    }
    const text = doc.getText();
    const offset = doc.offsetAt(pos);
    const tag = findEnclosingTag(text, offset);
    if (!tag) {
      return undefined;
    }
    const def = TAG_BY_NAME.get(tag.name);
    if (!def) {
      return undefined;
    }
    // 光标在标签内、且不在某个属性值里
    // 空值（field="")也算在值内，否则会嵌套插入属性片段生成非法 XML
    const inAttrValue = tag.attrs.find((a) => offset > a.valueStart - 1 && offset <= a.valueEnd + 1);
    if (inAttrValue) {
      return undefined;
    }
    const existing = new Set(tag.attrs.map((a) => a.name));
    return def.attrs
      .filter((a) => !existing.has(a.name))
      .map((a) => {
        const item = new vscode.CompletionItem(a.name, vscode.CompletionItemKind.Property);
        item.insertText = new vscode.SnippetString(`${a.name}="$0"`);
        item.detail = a.required ? `${a.name}（必需）` : a.name;
        item.sortText = a.required ? `0${a.name}` : `1${a.name}`;
        return item;
      });
  }
}

export class FenixParamCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: FenixIndex) {}

  async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position):
    Promise<vscode.CompletionItem[] | undefined> {
    if (!isFenixXmlDoc(doc)) {
      return undefined;
    }
    const text = doc.getText();
    const offset = doc.offsetAt(pos);

    // 上下文一：#{...} 或 @if{...} 花括号内
    const braced = inBracedExpression(text, offset);
    let segment: string | undefined;
    let replaceFrom: number;
    if (braced) {
      segment = braced.segment;
      replaceFrom = braced.openOffset + 1;
    } else {
      // 上下文二：引用参数的属性值里（match / value / start / end ...）
      const tag = findEnclosingTag(text, offset);
      if (!tag) {
        return undefined;
      }
      const attr = tag.attrs.find((a) => offset >= a.valueStart && offset <= a.valueEnd + 1);
      if (!attr || !PARAM_VALUE_ATTRS.has(attr.name)) {
        return undefined;
      }
      segment = attr.value.slice(0, offset - attr.valueStart);
      replaceFrom = attr.valueStart;
    }
    if (segment === undefined) {
      return undefined;
    }

    // 找到所在语句 → Dao 方法 → 参数
    const ns = parseNamespace(text);
    const stmtId = findEnclosingStatementId(text, offset);
    if (!ns || !stmtId) {
      return undefined;
    }
    const dao = await this.index.daoOf(ns);
    if (!dao) {
      return undefined;
    }
    const method = dao.methods.find((m) => m.name === stmtId);
    if (!method) {
      return undefined;
    }

    const dot = segment.lastIndexOf('.');
    // 只替换光标前正在输入的标识符；否则在 @if{a == b && | 这类复合表达式里接受补全会把整段表达式删掉
    const partial = /[A-Za-z0-9_$]*$/.exec(segment)?.[0] ?? '';
    const wordStart = replaceFrom + segment.length - partial.length;
    const range = new vscode.Range(doc.positionAt(wordStart), pos);

    // 二级：paramName.field
    if (dot >= 0) {
      const paramName = segment.slice(0, dot).split(/[^\w.]/).pop() ?? '';
      const param = method.params.find((p) => (p.paramName ?? p.varName) === paramName);
      if (!param) {
        return undefined;
      }
      const fields = await this.index.voFieldsOf(param.typeSimple, dao);
      return fields.map((f) => ({
        label: f,
        kind: vscode.CompletionItemKind.Field,
        insertText: f,
        range,
        detail: `${param.typeSimple}.${f}`,
      }));
    }

    // 一级：参数名（@Param 名优先，无注解用变量名）
    return method.params.map((p) => ({
      label: p.paramName ?? p.varName,
      kind: vscode.CompletionItemKind.Variable,
      insertText: p.paramName ?? p.varName,
      range,
      detail: `${p.typeSimple} ${p.varName}${p.paramName ? `（@Param("${p.paramName}")）` : ''}`,
    }));
  }
}

