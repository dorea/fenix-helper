import { sanitizeFileName } from '../src/naming';
import * as fs from 'fs';
/**
 * 无 VS Code 依赖的直跑测试（node out/sanity.mjs）。
 * 样本取自真实的 fenix 用法（脱敏后的示例）。
 */

import { parseFenixXml, findEnclosingTag, findEnclosingStatementId, inBracedExpression, lineAt, findTagSpans, lineStartOffset } from '../src/xmlParser';
import { parseDaoFile, parseVoFile, resolveFqn, splitQueryFenixValue } from '../src/javaScanner';
import { FENIX_TAGS, TAG_BY_NAME } from '../src/xsdData';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}\n  actual:   ${a}\n  expected: ${e}`);
  }
}

// ---------- 样本 1：fenix XML ----------
const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<fenixs namespace="com.example.demo.dao.UserDao">

    <fenix id="countByUserQueryVo">
        select
            count(*)
        from
            t_user u
        where
            u.delete_mark = 'N'
            <andEqual field="u.plant_code" value="qv.plant" match="qv.plant != empty"/>
            <andLike field="u.supp_code" value="qv.supp" match="qv.supp != empty"/>
            @if{qv.suppForwarderCode != empty}
                and u.plant_code = #{qv.plant}
            @end{}
    </fenix>

    <fenix id="findByUserQueryVo" resultType="com.example.demo.model.User">
        select * from t_user u where ch.id = #{qv.id}
    </fenix>

</fenixs>
`;

// ---------- 样本 2：Dao 接口 ----------
const DAO_SAMPLE = `package com.example.demo.dao;

import com.blinkfox.fenix.jpa.QueryFenix;
import com.example.demo.vo.query.UserQueryVo;
import com.example.demo.model.User;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository("demoUserDao")
public interface UserDao extends BaseRepository<User, Long> {

    @QueryFenix(nativeQuery = true)
    Integer countByUserQueryVo(@Param("qv") UserQueryVo qv);

    @QueryFenix
    List<User> findByUserQueryVo(@Param("qv") UserQueryVo qv, Pageable pageable);
}
`;

// ---------- 样本 3：参数 VO ----------
const VO_SAMPLE = `package com.example.demo.vo.query;

public class UserQueryVo extends BaseQueryVo {
    private String plant;
    private String supp;
    private Integer status;
    private List<String> ids;
    public UserQueryVo() {}
}
`;

// ---------- xmlParser ----------
{
  const info = parseFenixXml(XML_SAMPLE);
  eq(info.namespace, 'com.example.demo.dao.UserDao', 'parseFenixXml.namespace');
  eq(info.statements.length, 2, 'parseFenixXml.statements.length');
  eq(info.statements[0].id, 'countByUserQueryVo', 'parseFenixXml.statements[0].id');
  eq(info.statements[0].line, 3, 'parseFenixXml.statements[0].line (0-based)');
  eq(info.statements[1].id, 'findByUserQueryVo', 'parseFenixXml.statements[1].id');
  eq(info.statements[1].resultType, 'com.example.demo.model.User', 'parseFenixXml.resultType');
}

{
  // 光标停在 match 属性值里 → attr 上下文
  const tagOpen = XML_SAMPLE.indexOf('<andEqual');
  const matchAttrVal = XML_SAMPLE.indexOf('qv.plant != empty', tagOpen);
  const tag = findEnclosingTag(XML_SAMPLE, matchAttrVal + 3);
  eq(tag?.name, 'andEqual', 'findEnclosingTag.name');
  eq(tag?.attrs.length, 3, 'findEnclosingTag.attrs.length');
  const matchAttr = tag?.attrs.find((a) => a.name === 'match');
  eq(matchAttr?.value, 'qv.plant != empty', 'findEnclosingTag.matchAttr.value');
  eq(XML_SAMPLE.slice(matchAttr?.valueStart ?? -1, matchAttr?.valueEnd ?? -1), 'qv.plant != empty', 'matchAttr span');
}

{
  // 光标在 SQL 文本 #{qv.plant} 处 → 所在语句
  const hashIdx = XML_SAMPLE.indexOf('#{qv.plant}');
  eq(findEnclosingStatementId(XML_SAMPLE, hashIdx + 3), 'countByUserQueryVo', 'findEnclosingStatementId in #{}');
  const ifIdx = XML_SAMPLE.indexOf('@if{');
  eq(findEnclosingStatementId(XML_SAMPLE, ifIdx + 5), 'countByUserQueryVo', 'findEnclosingStatementId in @if{}');
  const stmt2 = XML_SAMPLE.indexOf('#{qv.id}');
  eq(findEnclosingStatementId(XML_SAMPLE, stmt2 + 3), 'findByUserQueryVo', 'findEnclosingStatementId second stmt');
}

{
  // #{ 花括号表达式上下文
  const hashIdx = XML_SAMPLE.indexOf('#{qv.plant}');
  const ctx = inBracedExpression(XML_SAMPLE, hashIdx + 4);
  eq(ctx?.segment, 'qv', 'inBracedExpression segment');
  const ctx2 = inBracedExpression(XML_SAMPLE, hashIdx + 2);
  eq(ctx2?.segment, '', 'inBracedExpression empty segment');
  const noCtx = inBracedExpression(XML_SAMPLE, XML_SAMPLE.indexOf('select'));
  eq(noCtx, null, 'inBracedExpression outside');
}

{
  eq(lineAt(XML_SAMPLE, 0), 0, 'lineAt 0');
  eq(lineAt(XML_SAMPLE, XML_SAMPLE.indexOf('<fenix id')), 3, 'lineAt statement line');
}

// ---------- javaScanner ----------
{
  const dao = parseDaoFile(DAO_SAMPLE);
  eq(dao.pkg, 'com.example.demo.dao', 'parseDaoFile.pkg');
  eq(dao.typeName, 'UserDao', 'parseDaoFile.typeName');
  eq(dao.methods.length, 2, 'parseDaoFile.methods.length');

  const m0 = dao.methods[0];
  eq(m0.name, 'countByUserQueryVo', 'parseDaoFile.m0.name');
  eq(m0.queryFenixValue, null, 'parseDaoFile.m0.queryFenixValue (nativeQuery only)');
  eq(m0.params.length, 1, 'parseDaoFile.m0.params.length');
  eq(m0.params[0].paramName, 'qv', 'parseDaoFile.m0.paramName');
  eq(m0.params[0].typeSimple, 'UserQueryVo', 'parseDaoFile.m0.typeSimple');
  eq(m0.params[0].varName, 'qv', 'parseDaoFile.m0.varName');
  eq(DAO_SAMPLE.slice(m0.nameOffset, m0.nameOffset + m0.name.length), 'countByUserQueryVo', 'm0.nameOffset points at name');

  const m1 = dao.methods[1];
  eq(m1.name, 'findByUserQueryVo', 'parseDaoFile.m1.name');
  eq(m1.params.length, 2, 'parseDaoFile.m1.params.length');
  eq(m1.params[1].varName, 'pageable', 'parseDaoFile.m1.param2.varName');

  eq(resolveFqn('UserQueryVo', dao), 'com.example.demo.vo.query.UserQueryVo', 'resolveFqn via import');
  eq(resolveFqn('com.foo.Bar', dao), 'com.foo.Bar', 'resolveFqn fqn passthrough');
}

{
  const vo = parseVoFile(VO_SAMPLE);
  eq(vo.fields.slice(0, 4), ['plant', 'supp', 'status', 'ids'], 'parseVoFile.fields');
  eq(vo.extendsSimple, 'BaseQueryVo', 'parseVoFile.extendsSimple');
}

{
  eq(splitQueryFenixValue('BlogRepository.queryMyBlogs'), { shortClassName: 'BlogRepository', fenixId: 'queryMyBlogs' }, 'splitQueryFenixValue ok');
  eq(splitQueryFenixValue('nodot'), null, 'splitQueryFenixValue no dot');
}

// ---------- xsdData ----------
{
  eq(FENIX_TAGS.length >= 50, true, `FENIX_TAGS.length=${FENIX_TAGS.length} >= 50`);
  eq(TAG_BY_NAME.has('andEqual'), true, 'TAG_BY_NAME has andEqual');
  eq(TAG_BY_NAME.has('andBetween'), true, 'TAG_BY_NAME has andBetween');
  eq(TAG_BY_NAME.has('fenixs'), true, 'TAG_BY_NAME has fenixs');
  const andEqual = TAG_BY_NAME.get('andEqual')!;
  eq(andEqual.attrs.some((a) => a.name === 'match'), true, 'andEqual has match attr');
  const between = TAG_BY_NAME.get('andBetween')!;
  eq(between.attrs.filter((a) => a.required).map((a) => a.name), ['field', 'start', 'end'], 'between required attrs');
}

// ---------- fenixExpr：表达式求值 ----------
import { evalCondition, evalExpr, parseExpr, refsOfExpr, validateExpr, renderTemplate } from '../src/fenixExpr';

{
  const ctx = { qv: { plant: 'P01', status: 3, flag: true }, ids: [1, 2] };
  eq(evalCondition('qv.plant != empty', ctx), true, 'expr: qv.plant != empty (set)');
  eq(evalCondition('qv.plant != empty', { qv: {} }), false, 'expr: qv.plant != empty (unset)');
  eq(evalCondition('', ctx), true, 'expr: empty condition is always true');
  eq(evalCondition('qv.status == 3', ctx), true, 'expr: == number');
  eq(evalCondition('!qv.flag', ctx), false, 'expr: unary !');
  eq(evalCondition('(?qv.a != empty) || (?qv.b != empty)', ctx), false, 'expr: null-safe both unset');
  eq(evalCondition('(?qv.a != empty) || (?qv.plant != empty)', ctx), true, 'expr: null-safe one set');
  eq(evalCondition('qv.plant != empty && qv.status > 2', ctx), true, 'expr: && and >');
  eq(evalCondition('ids != empty', ctx), true, 'expr: array not empty');
  eq(evalCondition('ids != empty', { ids: [] }), false, 'expr: empty array');

  const ast = parseExpr('1 + 2');
  eq('error' in ast ? 'err' : evalExpr(ast, {}), 3, 'expr: arithmetic +');
}

// ---------- fenixExpr：语法校验 ----------
{
  eq(validateExpr('qv.plant != empty').ok, true, 'validate: ok expr');
  eq(validateExpr("qv.name == 'foo'").ok, true, 'validate: string literal');
  eq(validateExpr('qv.plant &&').ok, false, 'validate: dangling &&');
  eq(validateExpr('((qv.a != empty)').ok, false, 'validate: unbalanced paren');
  eq(validateExpr('qv.a !=').ok, false, 'validate: incomplete cmp');
  const refs = refsOfExpr('qv.plant != empty && ids != empty');
  eq(Array.isArray(refs) ? refs : [], [['qv', 'plant'], ['ids']], 'refsOfExpr');
}

// ---------- fenixExpr：模板渲染 ----------
{
  const ctx = { qv: { a: 'A', b: 'B' } };
  eq(renderTemplate('@if{qv.a != empty}X@end{}', ctx).out, 'X', 'tpl: @if hit');
  eq(renderTemplate('@if{qv.z != empty}X@end{}', ctx).out, '', 'tpl: @if miss');
  eq(renderTemplate('@if{qv.z != empty}X@else{}Y@end{}', ctx).out, 'Y', 'tpl: @else');
  eq(renderTemplate('@if{qv.a != empty}X@elseif{qv.b != empty}Y@else{}Z@end{}', { qv: { b: 'B' } }).out, 'Y', 'tpl: @elseif');
  eq(renderTemplate('a@{qv.a}b', ctx).out, 'aAb', 'tpl: @{} interpolation');
  eq(renderTemplate('a@@{not}', ctx).out, 'a@{not}', 'tpl: @@ escape');
  eq(renderTemplate('@if{qv.a != empty}@if{qv.b != empty}XY@end{}@end{}', ctx).out, 'XY', 'tpl: nested @if');
}

// ---------- sqlRenderer：SQL 渲染（真实形态样本） ----------
import { parseFenixDocument, renderStatement, replaceBlank } from '../src/sqlRenderer';

{
  eq(replaceBlank('  a\n\t b   c |d'), 'a b c d', 'replaceBlank faithful');
}

const RENDER_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<fenixs namespace="com.example.demo.dao.UserDao">

    <fenix id="countByUserQueryVo">
        select
            count(*)
        from
            t_user u
        where
            u.delete_mark = 'N'
            <andEqual field="u.plant_code" value="qv.plant" match="qv.plant != empty"/>
            <andLike field="u.supp_code" value="qv.supp" match="qv.supp != empty"/>
            <andBetween field="u.create_time" start="qv.start" end="qv.end" match="(?qv.start != empty) || (?qv.end != empty)"/>
            @if{qv.suppForwarderCode != empty}
                and u.consignor_no = #{qv.suppForwarderCode}
            @end{}
            and u.name like '%@{qv.queryValue}%'
    </fenix>

</fenixs>
`;

{
  const fd = parseFenixDocument(RENDER_SAMPLE);
  eq(fd.namespace, 'com.example.demo.dao.UserDao', 'render: namespace');
  eq(fd.statements.length, 1, 'render: stmt count');
  const stmt = fd.statements[0];

  // 全空参数：动态条件全部不生成，@if 不命中，@{} 插空
  const empty = renderStatement(stmt.node, { qv: {} });
  eq(empty.sql, `select count(*) from t_user u where u.delete_mark = 'N' and u.name like '%%'`, 'render: empty ctx sql');
  eq(empty.params.length, 0, 'render: empty ctx params');
  const skipLabels = empty.branches.filter((b) => !b.included).length;
  eq(skipLabels >= 4, true, 'render: 4+ skipped branches');

  // 全量命中
  const full = renderStatement(stmt.node, {
    qv: { plant: 'P01', supp: 'SUP', start: '2026-01-01', end: '2026-12-31', suppForwarderCode: 'F01', queryValue: 'kw' },
  });
  eq(full.sql.includes('AND u.plant_code = :qv_plant'), true, 'render: andEqual fragment');
  eq(full.sql.includes('AND u.supp_code LIKE :qv_supp'), true, 'render: andLike fragment');
  eq(full.sql.includes('BETWEEN :qv_start AND :qv_end'), true, 'render: between fragment');
  eq(full.sql.includes('consignor_no = :qv_suppForwarderCode'), true, 'render: #{} → :named');
  eq(full.sql.includes("u.name like '%kw%'"), true, 'render: @{} interpolation');
  const paramMap = new Map(full.params.map((p) => [p.name, p.value]));
  eq(paramMap.get('qv_plant'), 'P01', 'render: param qv_plant');
  eq(paramMap.get('qv_supp'), '%SUP%', 'render: like wraps %..%');
  eq(paramMap.get('qv_start'), '2026-01-01', 'render: between start param');
  eq(paramMap.get('qv_suppForwarderCode'), 'F01', 'render: #{} param value');

  // between 半开：只有 start → >=
  const half = renderStatement(stmt.node, { qv: { start: '2026-01-01' } });
  eq(half.sql.includes('u.create_time >= :qv_start'), true, 'render: between start-only → >=');

  // 未知标签 → warning + 分支标记
  const badFd = parseFenixDocument('<fenixs namespace="a.B"><fenix id="x"><andEqaul field="f" value="v"/></fenix></fenixs>');
  const bad = renderStatement(badFd.statements[0].node, {});
  eq(bad.warnings.some((w) => w.includes('andEqaul')), true, 'render: unknown tag warning');
}


// ---------- v0.2/v0.3 修复回归：OCR review 发现的问题 ----------
{
  // 裸标签名（无 and/or 前缀）— 之前被生成为 Equal/In/Like，导致预览静默丢片段
  const doc = parseFenixDocument(
    '<fenixs namespace="a.B"><fenix id="x">select * from t where <equal field="t.a" value="p.a"/><in field="t.b" value="p.ids"/><isNull field="t.c"/></fenix></fenixs>',
  );
  const r = renderStatement(doc.statements[0].node, { p: { a: 'A', ids: [1, 2] } });
  eq(r.sql.includes('t.a = :p_a'), true, 'bare <equal> rendered');
  eq(r.sql.includes('t.b IN :p_ids'), true, 'bare <in> rendered');
  eq(r.sql.includes('t.c IS NULL'), true, 'bare <isNull> rendered');
  eq(r.warnings.length, 0, 'bare tags produce no warnings');
}

{
  // <where> 的 prependWhere + WHERE AND 修剪
  const doc = parseFenixDocument(
    '<fenixs namespace="a.B"><fenix id="x">select * from t<where><andEqual field="t.a" value="p.a"/><andEqual field="t.b" value="p.b" match="p.b != empty"/></where></fenix></fenixs>',
  );
  const r = renderStatement(doc.statements[0].node, { p: { a: 'A' } });
  eq(r.sql, 'select * from t WHERE t.a = :p_a', 'where block: prepend WHERE, trim AND');
}

{
  // <choose>：第 2 对条件在 fenix 运行时是 when2/then2（不是 when1）
  const doc = parseFenixDocument(
    '<fenixs namespace="a.B"><fenix id="x">select 1<choose when="p.a != empty" then=" and x=1" when2="p.b != empty" then2=" and x=2" else=" and x=3"/></fenix></fenixs>',
  );
  const second = renderStatement(doc.statements[0].node, { p: { b: 'B' } });
  eq(second.sql, 'select 1 and x=2', 'choose: second pair is when2/then2');
  const fallback = renderStatement(doc.statements[0].node, { p: {} });
  eq(fallback.sql, 'select 1 and x=3', 'choose: else fallback');
}

{
  // <set>：第 2 组是 field2/value2（不是 field1）
  const doc = parseFenixDocument(
    '<fenixs namespace="a.B"><fenix id="x">update t<set field="a" value="p.a" field2="b" value2="p.b" match2="p.b != empty"/></fenix></fenixs>',
  );
  const r = renderStatement(doc.statements[0].node, { p: { a: 'A', b: 'B' } });
  eq(r.sql, 'update t SET a = :a, b = :b', 'set: second pair is field2/value2');
}

{
  // <import>：同一片段被引用两次是合法的（不是循环引用）；真环才报错
  const doc = parseFenixDocument(
    '<fenixs namespace="a.B">' +
      '<fenix id="frag">x = 1</fenix>' +
      '<fenix id="x"><import fenixId="frag"/> union <import fenixId="frag"/></fenix>' +
      '</fenixs>',
  );
  const fragNode = doc.statements.find((s) => s.id === 'frag')!.node;
  const main = doc.statements.find((s) => s.id === 'x')!.node;
  const r = renderStatement(main, {}, { currentNamespace: 'a.B', resolveImport: () => fragNode });
  eq(r.sql, 'x = 1 union x = 1', 'import: same fragment twice is fine');
  eq(r.warnings.filter((w) => w.includes('循环')).length, 0, 'import: no false cycle warning');
}

{
  // 表达式：方法调用 / 下标 / 一元负号 都是合法 MVEL
  eq(validateExpr('ids.size() > 0').ok, true, 'validate: method call');
  eq(evalCondition('ids.size() > 0', { ids: [1] }), true, 'eval: size() > 0');
  eq(evalCondition('ids.size() > 0', { ids: [] }), false, 'eval: empty size()');
  eq(validateExpr('ids[0] != empty').ok, true, 'validate: index access');
  eq(evalCondition('p.count > -1', { p: { count: 3 } }), true, 'eval: unary minus');
  eq(validateExpr('1.2.3').ok, false, 'validate: malformed number rejected');
}

{
  // @QueryFenix 值形式（简写）必须解析出来 —— 之前被当成空注解
  const dao = parseDaoFile('package a; import x.QueryFenix; interface D { @QueryFenix("OtherDao.someId") java.util.List<Foo> f(int a); }');
  eq(dao.methods[0].queryFenixValue, 'OtherDao.someId', 'parseDaoFile: @QueryFenix("A.b") shorthand');
  const dao2 = parseDaoFile('package a; interface D { @QueryFenix(value = "OtherDao.someId") Foo f(int a); }');
  eq(dao2.methods[0].queryFenixValue, 'OtherDao.someId', 'parseDaoFile: value= form');
}

{
  // 注释掉的 @QueryFenix 不参与索引
  const raw = [
    'package a; interface D {',
    '  // @QueryFenix',
    '  // Integer removed(@Param("q") Q q);',
    '  @QueryFenix Integer alive(@Param("q") Q q);',
    '}',
  ].join('\n');
  const dao = parseDaoFile(raw);
  eq(dao.methods.map((m) => m.name), ['alive'], 'parseDaoFile: commented method ignored');
}

{
  // 参数解析：final / varargs / 泛型通配符 / 注解内逗号
  const dao = parseDaoFile('package a; interface D { @QueryFenix void f(@Param("a") final String a, @Param("b") String... b, @Param("c") java.util.List<? extends Foo> c, @DateTimeFormat(pattern = "yyyy-MM-dd,HH") @Param("d") java.util.Date d); }');
  eq(dao.methods[0].params.length, 4, 'params: final/varargs/wildcard/annotation-comma all parsed');
  eq(dao.methods[0].params.map((p) => p.paramName), ['a', 'b', 'c', 'd'], 'params: names');
}


{
  // 文本节点保留 raw（未反转义），诊断 offset 才能对上文档位置
  const xml = '<fenixs namespace="a.B"><fenix id="x">select 1 where a &lt; b @if{p.a != empty} and b = 2 @end{}</fenix></fenixs>';
  const doc = parseFenixDocument(xml);
  const stmt = doc.statements[0].node;
  const texts = stmt.children.filter((c) => c.kind === 'text') as Array<{ text: string; raw: string; start: number }>;
  const withEntity = texts.find((t) => t.raw.includes('&lt;'))!;
  eq(withEntity.text.includes('a < b'), true, 'text node: unescaped for rendering');
  eq(withEntity.raw.includes('a &lt; b'), true, 'text node: raw kept for offset mapping');
  // raw 与文档切片必须逐字相同
  eq(xml.slice(withEntity.start, withEntity.start + withEntity.raw.length), withEntity.raw, 'text node: raw offset maps to document');
}

{
  // 语法高亮的 include 必须都能解析（避免又出现编译失败）
  const g = JSON.parse(fs.readFileSync(new URL('../syntaxes/fenix-sql-injection.tmLanguage.json', import.meta.url), 'utf8'));
  const refs = [...JSON.stringify(g).matchAll(/"#([a-z-]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(refs)].filter((r) => !g.repository[r]);
  eq(missing, [], 'tmLanguage: all includes resolve');
  eq(JSON.stringify(g).includes('[^]'), false, 'tmLanguage: no Oniguruma-invalid [^]');
}


{
  // 跨包继承：子类 extends 其它包的父类（父类由 VO 自己的 import 引入）
  // 必须用 VO 自己的 package/import 解析父类，而不是 Dao 的
  const voText = [
    'package com.example.demo.vo.site;',
    'import com.example.demo.vo.query.UserQueryVo;',
    'public class SiteUploadQueryVo extends UserQueryVo {',
    '    private String batteryNo;',
    '}',
  ].join('\n');
  const vo = parseVoFile(voText);
  eq(vo.extendsSimple, 'UserQueryVo', 'vo: extends parsed');
  eq(vo.pkg, 'com.example.demo.vo.site', 'vo: own package kept');
  eq(vo.imports.get('UserQueryVo'), 'com.example.demo.vo.query.UserQueryVo', 'vo: own import kept');
  // 用 VO 自己的上下文解析父类 → 指向父类的真实 FQN（而不是同包的假想类）
  const parentFqn = resolveFqn(vo.extendsSimple!, {
    pkg: vo.pkg,
    typeName: null,
    imports: vo.imports,
    methods: [],
  });
  eq(parentFqn, 'com.example.demo.vo.query.UserQueryVo', 'vo: parent resolved via own imports');
}

{
  // 文件名净化：不能含路径分隔符、不能上跳
  const evil = sanitizeFileName('../../evil.xml');
  eq(evil.includes('/'), false, 'sanitize: no slash');
  eq(evil.includes('\\'), false, 'sanitize: no backslash');
  eq(evil.includes('..'), false, 'sanitize: no parent traversal');
  eq(evil.endsWith('evil.xml'), true, 'sanitize: keeps basename');
  eq(sanitizeFileName('a/b_c.xml'), 'a_b_c.xml', 'sanitize: separators replaced');
}


{
  // CodeLens 坐标回归：列必须由「行号」求行首，不能把 offset 当行号
  // （历史 bug：lineStartOffset(text, valueStart) → 列错位 → 点击提示「未找到对应的 Dao 方法」）
  const t = XML_SAMPLE;
  for (const tag of findTagSpans(t)) {
    if (tag.name !== 'fenix') {
      continue;
    }
    const idAttr = tag.attrs.find((a) => a.name === 'id')!;
    const idLine = lineAt(t, idAttr.valueStart);
    const idCol = idAttr.valueStart - lineStartOffset(t, idLine);
    // 模拟 CodeLens 点击：handler 用 (line, col+1) 反推 offset 再定位
    const offset = lineStartOffset(t, idLine) + idCol + 1;
    const hit = findEnclosingTag(t, offset)?.attrs.find((a) => a.name === 'id');
    eq(hit?.value, idAttr.value, `codelens position maps back for ${idAttr.value}`);
  }
}


// ---------- 预览面板：条件分析 / 上下文 / 内联 ----------
import { analyzeStatement, buildContext, inlineParams, rootOf } from '../src/analyze';

const PANEL_SAMPLE = `<fenixs namespace="a.Dao">
    <fenix id="q">
        SELECT * FROM t
        <where>
            <andEqual field="t.env" value="qv.env" match="qv.env != empty"/>
            <andLike field="t.name" value="qv.name" match="qv.name != empty"/>
            <andBetween field="t.dt" start="qv.start" end="qv.end" match="(?qv.start != empty) || (?qv.end != empty)"/>
            @if{qv.flag != empty}
                and t.flag = #{qv.flag}
            @end{}
        </where>
        and t.kw like '%@{qv.kw}%'
    </fenix>
</fenixs>`;

{
  const fd = parseFenixDocument(PANEL_SAMPLE);
  const a = analyzeStatement(fd.statements[0].node);
  // 3 个 match 标签 + 1 个 @if
  eq(a.conditions.length, 4, 'panel: condition count');
  eq(a.conditions.map((c) => c.kind), ['tag', 'tag', 'tag', 'if'], 'panel: condition kinds');
  eq(a.conditions[0].label, '<andEqual field="t.env">', 'panel: label');
  eq(a.conditions[0].inputs, ['qv.env'], 'panel: single input');
  eq(a.conditions[2].inputs, ['qv.start', 'qv.end'], 'panel: between has two inputs');
  // qv.kw 只出现在 @{} 插值里 → 自由参数
  eq(a.freeParams.includes('qv.kw'), true, 'panel: free param detected');
}

{
  // 勾选/取消 控制条件生成
  const fd = parseFenixDocument(PANEL_SAMPLE);
  const node = fd.statements[0].node;
  const a = analyzeStatement(node);
  const all = new Map(a.conditions.map((c) => [c.key, true]));
  const ctx = buildContext({ 'qv.env': 'E1', 'qv.name': 'N1', 'qv.start': '2026-01-01', 'qv.end': '2026-12-31', 'qv.kw': 'KW' });
  const r1 = renderStatement(node, ctx, { overrides: all });
  eq(r1.sql.includes('t.env = :qv_env'), true, 'panel: checked tag included');
  eq(r1.sql.includes('LIKE :qv_name'), true, 'panel: like included');
  eq(r1.sql.includes('BETWEEN :qv_start AND :qv_end'), true, 'panel: between included');
  eq(r1.sql.includes("like '%KW%'"), true, 'panel: {} interpolation');

  const none = new Map(a.conditions.map((c) => [c.key, false]));
  const r2 = renderStatement(node, ctx, { overrides: none });
  eq(r2.sql.includes('qv_env'), false, 'panel: unchecked tag excluded');
  eq(r2.sql.includes('BETWEEN'), false, 'panel: unchecked between excluded');
}

{
  // 勾选但没填值：条件仍然生成（match 被强制为 true）
  const fd = parseFenixDocument(PANEL_SAMPLE);
  const a = analyzeStatement(fd.statements[0].node);
  const first = a.conditions[0];
  const ov = new Map([[first.key, true], ...a.conditions.slice(1).map((c) => [c.key, false] as [string, boolean])]);
  const r = renderStatement(fd.statements[0].node, buildContext({}), { overrides: ov });
  eq(r.sql.includes('t.env = :qv_env'), true, 'panel: checked without value still generates');
}

{
  // 内联参数：字符串加引号、数字裸写、数组展开、null
  const sql = 'a = :p_s and b = :p_n and c in :p_arr and d = :p_null';
  const out = inlineParams(sql, [
    { name: 'p_s', value: "O'Reilly" },
    { name: 'p_n', value: 42 },
    { name: 'p_arr', value: ['x', 'y'] },
    { name: 'p_null', value: null },
  ]);
  eq(out, "a = 'O''Reilly' and b = 42 and c in ('x', 'y') and d = null", 'inline: literals');
  eq(rootOf('qv.plant'), 'qv', 'rootOf');
}


// ---------- XML 位置发现（fenix 目录名可自定义） ----------
import { parseXmlLocations, cleanLocation, globsForLocations, DEFAULT_XML_GLOBS } from '../src/xmlLocations';

{
  // yml 列表形式
  const yml = [
    'spring:',
    '  datasource:',
    '    url: jdbc:xxx',
    'fenix:',
    '  print-banner: true',
    '  xml-locations:',
    '    - fenix',
    '    - md-fenix',
    '  print-sql: false',
  ].join('\n');
  eq(parseXmlLocations(yml), ['fenix', 'md-fenix'], 'xml-locations: yml list');

  // yml 内联
  eq(parseXmlLocations('fenix:\n  xml-locations: base-fenix'), ['base-fenix'], 'xml-locations: yml inline');

  // properties 形式（多个逗号分隔）
  const props = 'fenix.xml-locations=fenix, md-fenix ,base-fenix\nother.key=1';
  eq(parseXmlLocations(props), ['fenix', 'md-fenix', 'base-fenix'], 'xml-locations: properties');

  // 无配置 → 空
  eq(parseXmlLocations('server:\n  port: 8080'), [], 'xml-locations: none');

  // classpath: 前缀与通配后缀会被清掉
  eq(cleanLocation('classpath*:fenix/**/*.xml'), 'fenix', 'cleanLocation: classpath + wildcard');
  eq(cleanLocation('"md-fenix/"'), 'md-fenix', 'cleanLocation: quotes and slash');

  // 生成的 glob 覆盖 resources 下与任意位置
  const globs = globsForLocations(['md-fenix']);
  eq(globs.includes('**/src/main/resources/md-fenix/**/*.xml'), true, 'globs: resources path');
  eq(globs.includes('**/md-fenix/**/*.xml'), true, 'globs: anywhere');
  eq(DEFAULT_XML_GLOBS.some((g) => g.includes('*-fenix')), true, 'default globs cover *-fenix');
}

// ---------- 汇总 ----------
console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
