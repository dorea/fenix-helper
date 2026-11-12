# Fenix Helper — 设计文档

> blinkfox/fenix（Spring Data JPA 动态 SQL 扩展）的 VS Code 语言支持。
> 参照 JetBrains 平台的 Fenix 插件（plugin 17158）迁移并增强。

## 一、背景

- **fenix**：为 Spring Data JPA 提供 XML 方式的动态 SQL（JPQL / native SQL）。
  Repository 方法标注 `@QueryFenix`，SQL 写在 fenix 资源目录（默认为 `fenix/`，可配置为任意目录名）下的 XML 中，
  形如 `<fenix id="方法名">…</fenix>`。
- **JetBrains 插件**：提供 XML↔Java 双向跳转、`resultType` 类引用、字段补全、生成 mapper XML。
- **本扩展**：在 VS Code 上复刻上述能力，并补充静态诊断、SQL 预览、大纲树与 SQL 高亮。

## 二、目标项目的典型用法（功能取舍依据）

调研结论（决定哪些功能值得做）：

| 用法 | 观察 | 对设计的影响 |
|---|---|---|
| fenix XML 数量 | 百级文件、分布于多个 Maven 模块 | 索引规模小，正则解析足够，无需 language server |
| `@QueryFenix` 方法 | 数百处 | 同上 |
| Java 链式 API（`provider=`） | 不使用 | 不实现 |
| ActiveRecord / `BaseModel` | 不使用 | 不实现 |
| XML `resultType` 属性 | 基本不用（改由注解 `resultType=` 指定） | 保留通用实现，但不作为核心 |
| `nativeQuery = true` | 常见 | SQL 文本按 native SQL 处理，字段补全基于参数 VO |
| `@if{cond} … @end{}` 模板 | 常见 | SQL 预览必须实现 MVEL 模板求值 |
| `#{param.field}` / `@{param.field}` | 常见 | 参数补全/校验的核心对象是 `@Param` 名 + 参数 VO 字段 |
| `@QueryFenix` 空注解形式 | 主流用法 | `namespace` = Dao 全限定名，`id` = 方法名 |

典型形态：

```java
@Repository
public interface UserDao extends BaseRepository<User, Long> {
    @QueryFenix(nativeQuery = true)
    Integer countByQuery(@Param("qv") UserQueryVo qv);
}
```

```xml
<fenixs namespace="com.example.demo.dao.UserDao">
    <fenix id="countByQuery">
        select count(*) from t_user u
        where u.delete_mark = 'N'
        <andEqual field="u.plant_code" value="qv.plant" match="qv.plant != empty"/>
        @if{qv.forwarderCode != empty}
            and u.consignor_no = #{qv.forwarderCode}
        @end{}
    </fenix>
</fenixs>
```

## 三、IDEA 插件能力 → VS Code 映射

| IDEA 插件 | 迁移 | 实现 |
|---|---|---|
| XML `<fenix id>` → Java 方法（gutter 图标） | ✅ | `DefinitionProvider` + 可点击 `CodeLens` |
| Java `@QueryFenix` 方法 → XML | 部分 | **仅 CodeLens**（见「已知限制」） |
| `resultType` → 实体类 | ✅ | `DefinitionProvider` |
| XML 文本中实体字段补全 | 改造 | 改为 `#{param.字段}` 参数/VO 字段两级补全 |
| 参数补全 | ✅ | `#{` / `@if{` / `match` 等属性值内触发 |
| 生成 mapper XML | ✅ | `CodeAction` + 命令 |
| 新建 XML 模板 | ✅ | 命令 + snippets |
| DTD 校验 | 增强 | 基于官方 `fenix.xsd` 导出的标签/属性表 + snippet |
| Kotlin 支持 | ❌ | 不做 |
| ——（本扩展新增） | ✅ | 对齐诊断、表达式校验、SQL 预览、大纲树、SQL 高亮 |

## 四、架构

```
激活：onLanguage:xml / workspaceContains:**/fenix/** / workspaceContains:**/*-fenix/**

src/
  extension.ts     激活入口：建索引、注册 provider、命令、watcher
  fenixIndex.ts    内存索引 + Java 文件按需解析（不预热全量扫描）
  xmlParser.ts     fenix XML 轻量解析（正则，注释感知）
  javaScanner.ts   Dao / VO 解析（package、import、@QueryFenix、@Param、字段、extends）
  fenixExpr.ts     MVEL 子集：表达式解析/求值 + 模板渲染（@if/@elseif/@else/@end/@{}）
  sqlRenderer.ts   fenix 语句 mini-DOM + SQL 渲染（复刻 fenix 运行时管线）
  analyze.ts       语句条件/参数分析、上下文构建、参数内联
  navigation.ts    定义跳转 + XML 侧 CodeLens
  javaLenses.ts    Java 侧 CodeLens（跳转 XML / 缺失提示）
  completion.ts    标签、属性、参数三级补全
  diagnostics.ts   对齐诊断 + 表达式/引用/标签校验
  codeActions.ts   生成 XML 语句的快速修复
  fenixTree.ts     Explorer 侧 FENIX 大纲树
  preview.ts       SQL 预览 webview（表格式条件面板）
  xsdData.ts       从 fenix.xsd 导出的标签/属性表
```

### XML 文件发现（位置不固定）

fenix 的 `fenix.xml-locations` 是可配置的，目录名可能是 `fenix`、`md-fenix`、`base-fenix`，
也可能不在 `resources` 下。因此**不按固定路径匹配**：

1. 汇总候选 glob：默认 `fenix` / `*-fenix` 目录 + 设置 `fenixHelper.xmlGlobs`
   + 从 `application*.{yml,yaml,properties}` 读到的 `fenix.xml-locations`（生成的 glob 见 `xmlLocations.ts`）。
2. 逐个 `findFiles`，**用文件内容判定**：文件头出现 `<fenixs` 才算 fenix 文件。
3. providers 注册在「所有 XML」上，内部同样用内容判定（`isFenixXmlDoc`），
   所以 XML 放在任何目录都能获得跳转/补全/诊断。

### 索引策略（性能关键）

- **只索引 fenix XML**（定向 glob，百级文件，毫秒级）。
- **不全量扫描 `src/main/java`**：早期版本用 `findFiles` 建全量 FQN 表，
  在大型多模块仓库里会占满 VS Code 的文件搜索服务，导致其它扩展的
  `workspaceContains` 探测超时（实测会把同工作区的其它扩展挤掉不激活）。
- Java 侧改为**按需推导**：`FQN → **/src/main/java/<包路径>/<类名>.java`，定向 glob + 正负缓存。
- **不建 `**/src/main/java/**` 全量 watcher**：改为保存时按 FQN 精确失效 + mtime 缓存。
- 所有 provider 现读现算（未保存的编辑器缓冲优先），避免脏缓存。

## 五、fenix v2.7.0 运行时语义（渲染器复刻依据）

从 fenix 源码确认的关键行为：

1. `match`、`when`、`value`、`start`、`end` 都是 **MVEL 表达式**；
   `ParseHelper.isTrue` 只认 `Boolean.TRUE`（字符串 "true" 不算）。
2. `empty` 是 MVEL 的空值判定关键字（null / 空串 / 空集合 / 空 Map）。
3. 最终 SQL 会**整段再过一遍 MVEL 模板引擎**（`TemplateRuntime`），因此
   `@if{}` / `@elseif{}` / `@else{}` / `@end{}` / `@{表达式}` / `@@` 在 SQL 文本里生效。
4. 之后执行 `replaceBlank`：**删除 `|`、`\t`、`\r`、`\n`**，多空格压成一个 ——
   注意 SQL 里的 `||` 拼接会被吃掉。
5. `#{xxx}` 在渲染后替换为命名参数 `:xxx`，名字按 `fixDot` 规则（`qv.plant` → `qv_plant`）。
6. `WHERE AND` / `WHERE OR` / `WHERE ORDER BY` / `WHERE GROUP BY` 会被修剪。
7. 标签的 prefix/symbol 由注册表决定：`equal` → ` = `，`andEqual` → ` AND ` + ` = `；
   `like` 默认包 `%v%`，`startsWith` → `v%`，`endsWith` → `%v`。
8. `between` 半开自动降级：只有 start → `>=`，只有 end → `<=`，两端都有 → `BETWEEN`。
9. `in` 的 value 求值为 null 时整条跳过。
10. `<choose>` / `<set>` 的编号属性有个历史坑：运行时用
    `x = i==1 ? "" : String(i)`，即读 `when/when2/when3`、`field2/value2/match2`，
    **`when1/then1`、`field1/value1` 不会被读取**（XSD 里存在但实现忽略）。
    渲染器与补全数据均按运行时行为对齐。
11. `<import>` 用值渲染其它语句，支持 `namespace` 省略（同文件）与 `value` 换上下文。
12. XML 注释里的语句不会被执行 —— 解析器同样跳过注释区间。

## 六、诊断规则

| 位置 | 规则 | 级别 |
|---|---|---|
| XML | `namespace` 指向的 Dao 不存在 | Error |
| XML | `<fenix id>` 找不到对应 `@QueryFenix` 方法 | Warning |
| XML | 未注册的 fenix 标签（运行时会抛 `NodeNotFoundException`） | Error |
| XML | `match`/`when`/`value`/`start`/`end`/`@if{}`/`@{}`/`#{}` 表达式语法错误 | Warning |
| XML | 引用了未定义的参数名 | Error |
| XML | 参数 VO 上不存在该字段（沿 `extends` 链追 6 层、跨包按各自 import 解析） | Error |
| Java | `@QueryFenix` 方法找不到 XML 语句 | Error |

注释掉的语句不参与诊断。

## 七、SQL 预览

- 入口：XML 语句行的 CodeLens `▶ 预览 SQL`。
- 面板为**表格式条件清单**：勾选框（是否生成该条件）/ 条件名 / 参数输入框。
- 勾选 = 强制包含（覆盖 `match` 求值），取消 = 强制排除。
- 参数值按 `ns#id` 记忆；输入即重渲染（防抖）。
- 输出两种视图：命名参数版（`:qv_plant`）与**参数已内联版**（`'AI01'`、数字裸写、数组展开）。
- 一键复制（走扩展进程剪贴板，避免 webview 权限问题）。

## 八、已知限制（VS Code 平台差异）

1. **没有可点击的 gutter 图标**：VS Code 未提供公开 API（IDEA 的 gutter 图标可点击是平台私有能力）。
   因此本扩展不用 gutter 图标，跳转入口是可点击的 CodeLens。
2. **无法屏蔽其它扩展的定义结果**：ctrl+点击 Dao 方法名时，Java 语言服务对「接口方法声明」
   本身会返回一个「自身定义」，VS Code 会合并所有 `DefinitionProvider` 的结果 → 显示 2 个。
   因此 Java 侧不注册 `DefinitionProvider`，跳转改用方法上方的 CodeLens（单击直达、无歧义）。
3. **没有官方 language injection API**：SQL 高亮通过 TextMate 注入语法实现
   （只影响 `*/resources/fenix/*.xml` 内 `<fenix>` 块中的文本，不动 XML 原生功能）。
4. 解析器基于正则而非 AST：对非常规写法（极端嵌套、非标准格式）可能降级，但覆盖实际用法足够。

## 九、测试

- `npm test`：纯 node 直跑，无 VS Code 依赖。覆盖 XML/Dao/VO 解析、索引解析规则、
  表达式引擎（含 MVEL 子集与模板）、SQL 渲染（各标签族、`where`、`choose`、`set`、`import`、
  `between` 降级、注释跳过）、诊断辅助、条件分析与参数内联。
- `npm run smoke`：把一批真实 fenix XML 逐个过渲染器，输出渲染后的 SQL 与警告，
  用于回归验证（不依赖具体项目）。

## 十、扩展点

- 新增标签：在 `xsdData.ts` 增加定义，并在 `sqlRenderer.ts` 的 `buildTagMeta` 里补注册（prefix/symbol）。
- 新增表达式能力：`fenixExpr.ts` 的 tokenizer / parser / evaluator 三处同步。
- 新增诊断：`diagnostics.ts` 的 `checkXmlDoc` / `checkNodeTree`。
