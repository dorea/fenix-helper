/**
 * fenix 标签/属性静态数据 —— 从官方 fenix.xsd（blinkfox/fenix 仓库）导出。
 * 用于标签补全、属性补全、snippet 生成。
 */

export interface AttrDef {
  name: string;
  required?: boolean;
}

export interface TagDef {
  name: string;
  attrs: AttrDef[];
  /** 补全 snippet 正文（占位符语法） */
  snippet: string;
  /** 补全项附加说明 */
  detail?: string;
}

const NORMAL_ATTRS: AttrDef[] = [
  { name: 'field', required: true },
  { name: 'value', required: true },
  { name: 'name' },
  { name: 'match' },
];

const LIKE_ATTRS: AttrDef[] = [
  { name: 'field', required: true },
  { name: 'value' },
  { name: 'pattern' },
  { name: 'name' },
  { name: 'match' },
];

const BETWEEN_ATTRS: AttrDef[] = [
  { name: 'field', required: true },
  { name: 'start', required: true },
  { name: 'end', required: true },
  { name: 'startName' },
  { name: 'endName' },
  { name: 'match' },
];

const NULL_ATTRS: AttrDef[] = [
  { name: 'field', required: true },
  { name: 'match' },
];

function tag(name: string, attrs: AttrDef[], snippetFn?: (n: string) => string, detail?: string): TagDef {
  const snippet = snippetFn
    ? snippetFn(name)
    : `<${name} field="$1" value="$2" match="$3 != empty"/>$0`;
  return { name, attrs, snippet, detail };
}

/** normal 族：field = value（match 成立时生成 `field = :value`） */
const NORMAL_NAMES = [
  'in', 'andIn', 'orIn', 'notIn', 'andNotIn', 'orNotIn',
  'notEqual', 'equal', 'andEqual', 'orEqual', 'andNotEqual', 'orNotEqual',
  'greaterThan', 'andGreaterThan', 'orGreaterThan',
  'lessThan', 'andLessThan', 'orLessThan',
  'greaterThanEqual', 'andGreaterThanEqual', 'orGreaterThanEqual',
  'lessThanEqual', 'andLessThanEqual', 'orLessThanEqual',
  'startsWith', 'andStartsWith', 'orStartsWith', 'notStartsWith', 'andNotStartsWith', 'orNotStartsWith',
  'endsWith', 'andEndsWith', 'orEndsWith', 'notEndsWith', 'andNotEndsWith', 'orNotEndsWith',
];

const LIKE_NAMES = ['like', 'andLike', 'orLike', 'notLike', 'andNotLike', 'orNotLike'];

const BETWEEN_NAMES = ['between', 'andBetween', 'orBetween'];

const NULL_NAMES = [
  'isNull', 'andIsNull', 'orIsNull',
  'isNotNull', 'andIsNotNull', 'orIsNotNull',
];

const OPERATOR_HINTS: Record<string, string> = {
  in: 'IN', andIn: 'AND … IN', orIn: 'OR … IN', notIn: 'NOT IN', andNotIn: 'AND … NOT IN', orNotIn: 'OR … NOT IN',
  notEqual: '!=', equal: '=', andEqual: 'AND =', orEqual: 'OR =', andNotEqual: 'AND !=', orNotEqual: 'OR !=',
  greaterThan: '>', andGreaterThan: 'AND >', orGreaterThan: 'OR >',
  lessThan: '<', andLessThan: 'AND <', orLessThan: 'OR <',
  greaterThanEqual: '>=', andGreaterThanEqual: 'AND >=', orGreaterThanEqual: 'OR >=',
  lessThanEqual: '<=', andLessThanEqual: 'AND <=', orLessThanEqual: 'OR <=',
  startsWith: 'LIKE "v%"', andStartsWith: 'AND LIKE "v%"', orStartsWith: 'OR LIKE "v%"',
  notStartsWith: 'NOT LIKE "v%"', andNotStartsWith: 'AND NOT LIKE "v%"', orNotStartsWith: 'OR NOT LIKE "v%"',
  endsWith: 'LIKE "%v"', andEndsWith: 'AND LIKE "%v"', orEndsWith: 'OR LIKE "%v"',
  notEndsWith: 'NOT LIKE "%v"', andNotEndsWith: 'AND NOT LIKE "%v"', orNotEndsWith: 'OR NOT LIKE "%v"',
  like: 'LIKE (自动加 %)', andLike: 'AND LIKE', orLike: 'OR LIKE', notLike: 'NOT LIKE', andNotLike: 'AND NOT LIKE', orNotLike: 'OR NOT LIKE',
  between: 'BETWEEN', andBetween: 'AND BETWEEN', orBetween: 'OR BETWEEN',
  isNull: 'IS NULL', andIsNull: 'AND IS NULL', orIsNull: 'OR IS NULL',
  isNotNull: 'IS NOT NULL', andIsNotNull: 'AND IS NOT NULL', orIsNotNull: 'OR IS NOT NULL',
};

export const FENIX_TAGS: TagDef[] = [
  // normal 族
  ...NORMAL_NAMES.map((n) => tag(n, NORMAL_ATTRS, undefined, `生成 \`${OPERATOR_HINTS[n]}\` 条件`)),
  // like 族（有 pattern 属性）
  ...LIKE_NAMES.map((n) => tag(n, LIKE_ATTRS, () => `<${n} field="$1" value="$2" match="$3 != empty"/>$0`, `生成 \`${OPERATOR_HINTS[n]}\` 条件`)),
  // between 族
  ...BETWEEN_NAMES.map((n) =>
    tag(n, BETWEEN_ATTRS, () => `<${n} field="$1" start="$2" end="$3" match="(?$2 != empty) || (?$3 != empty)"/>$0`, `生成 \`${OPERATOR_HINTS[n]}\` 条件`),
  ),
  // null 判断族
  ...NULL_NAMES.map((n) => tag(n, NULL_ATTRS, () => `<${n} field="$1" match="$2 != empty"/>$0`, `生成 \`${OPERATOR_HINTS[n]}\` 条件`)),
  // 特殊标签
  {
    name: 'text',
    attrs: [
      { name: 'value' },
      { name: 'match' },
    ],
    snippet: '<text value="$1" match="$2 != empty">$0</text>',
    detail: '原样输出一段 SQL 文本',
  },
  {
    name: 'import',
    attrs: [
      { name: 'fenixId', required: true },
      { name: 'namespace' },
      { name: 'value' },
      { name: 'match' },
    ],
    snippet: '<import namespace="$1" fenixId="$2" value="$3" match="$4 != empty"/>$0',
    detail: '引入其他 fenix 语句的 SQL 片段',
  },
  {
    // 注意：fenix v2.7.0 的 ChooseHandler 逐对读 when/then、when2/then2、when3/then3…
    // （x 后缀从 "" 直接跳到 2，when1/then1 不会被读取），XSD 里的 when1/then1 是实现遗留。
    name: 'choose',
    attrs: [
      { name: 'when' }, { name: 'when2' }, { name: 'when3' },
      { name: 'then' }, { name: 'then2' }, { name: 'then3' },
      { name: 'else' },
    ],
    snippet: '<choose when="$1" then="$2" when2="$3" then2="$4" else="$5"/>$0',
    detail: '多条件分支选择（when/then 对 + else；第 2 对是 when2/then2）',
  },
  {
    // 同 choose：SetHandler 读 field、field2、field3…（field1 不会被读取）
    name: 'set',
    attrs: [
      { name: 'field' }, { name: 'field2' }, { name: 'field3' },
      { name: 'value' }, { name: 'value2' }, { name: 'value3' },
      { name: 'match' }, { name: 'match2' }, { name: 'match3' },
    ],
    snippet: '<set field="$1" value="$2" match="$3 != empty"/>$0',
    detail: 'UPDATE SET 片段（自动去尾逗号；第 2 组是 field2/value2）',
  },
  {
    name: 'where',
    attrs: [],
    snippet: '<where>\n\t$0\n</where>',
    detail: 'WHERE 片段（自动修剪开头的 AND/OR）',
  },
  {
    name: 'trimWhere',
    attrs: [],
    snippet: '<trimWhere>\n\t$0\n</trimWhere>',
    detail: '同 where（自动修剪 AND/OR）',
  },
  {
    name: 'fenix',
    attrs: [
      { name: 'id', required: true },
      { name: 'resultType' },
      { name: 'removeIfExist' },
    ],
    snippet: '<fenix id="$1">\n\t$0\n</fenix>',
    detail: '一条 fenix 语句块（id = Dao 方法名）',
  },
  {
    name: 'fenixs',
    attrs: [{ name: 'namespace' }],
    snippet: '<fenixs namespace="$1">\n\t<fenix id="$2">\n\t\t$0\n\t</fenix>\n</fenixs>',
    detail: 'fenix XML 根节点（namespace = Dao 全限定名）',
  },
];

export const TAG_BY_NAME = new Map(FENIX_TAGS.map((t) => [t.name, t]));

/** 引用参数值的属性（在这些属性值里提供 #{param} 补全） */
export const PARAM_VALUE_ATTRS = new Set([
  'value', 'value1', 'value2', 'value3',
  'match', 'match1', 'match2', 'match3',
  'start', 'end', 'pattern', 'name', 'startName', 'endName',
  'when', 'when1', 'when2', 'when3', 'then', 'then1', 'then2', 'then3', 'else',
]);
