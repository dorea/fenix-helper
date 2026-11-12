# Fenix Helper

[blinkfox/fenix](https://github.com/blinkfox/fenix)（Spring Data JPA 动态 SQL）的 VS Code 支持。
功能对标 JetBrains 平台的 Fenix 插件，并补充静态诊断、SQL 预览与大纳树等能力。

## 功能

### 跳转

- fenix XML 里 `<fenix id="xxx">` 行上的 CodeLens → 跳转到 Dao 的 `@QueryFenix` 方法
- `<fenixs namespace="...">` 的 namespace → 跳转到 Dao 类
- `resultType` → 跳转到实体类；`<import fenixId>` → 跳转到目标语句
- Dao 方法上方的 CodeLens → 跳转到对应的 fenix XML 语句

### 补全

- `<` 触发：全部 fenix 标签（约 50 个，来自官方 `fenix.xsd`）+ 参数化片段
- 标签内空格触发：属性补全（标注必需项，过滤已输入）
- `#{` / `@if{` / `match`、`value` 等属性值内：`@Param` 名 → 参数 VO 字段 两级补全

### 诊断

- XML：`namespace` 指向的 Dao 不存在（Error）
- XML：`<fenix id>` 找不到对应 `@QueryFenix` 方法（Warning）
- XML：未注册的 fenix 标签（Error，运行时会抛 `NodeNotFoundException`）
- XML：`match` / `@if{}` / `#{}` 表达式语法错误（Warning）
- XML：引用未定义参数（Error）、参数 VO 上不存在该字段（Error，沿继承链跨包解析）
- Java：`@QueryFenix` 方法找不到 XML 语句（Error）

注释掉的语句不参与诊断。

### SQL 预览

语句行 CodeLens「▶ 预览 SQL」打开面板：

- **表格式条件清单**：勾选框（是否生成该条件）/ 条件名 / 参数输入框
- 勾选强制包含该条件，取消强制排除；在输入框填值即替换参数
- 输出两种视图：命名参数版（`:qv_plant`）与参数已内联版（`'AI01'`）
- 一键复制 SQL

### 其他

- **Code Action**：`@QueryFenix` 方法缺 XML 时一键生成语句节点/文件
- **大纲树**：Explorer 侧 FENIX 视图（模块 → 文件 → 语句），支持关键字过滤
- **SQL 高亮**：TextMate 注入语法，只影响 fenix 语句块内的文本
- **Snippets**：文件骨架、语句块、`@if` 块、`#{}` 插值
- **命令**：新建 fenix XML、预览 SQL、过滤/刷新大纲

## 约定

- **fenix XML 位置不做限定**：fenix 的 `xml-locations` 可自定义目录名（如 `fenix`、`md-fenix`、`base-fenix`）。
  扩展会自动识别 `fenix` / `*-fenix` 目录，并读取 `application*.yml` / `application*.properties` 里的
  `fenix.xml-locations`；也可用设置 `fenixHelper.xmlGlobs` 追加自定义 glob。
  最终以**文件内容**（根节点 `<fenixs`）判定是否为 fenix 文件，与目录位置无关。
- `@QueryFenix` 空注解形式：`namespace` = Dao 全限定名，`id` = 方法名
- 也兼容 `@QueryFenix("ShortName.methodId")` 值形式

## 已知限制

- VS Code 未提供「可点击的 gutter 图标」API，因此跳转入口统一为 CodeLens。
- Java 侧不注册 `DefinitionProvider`：Java 语言服务对接口方法声明本身会返回「自身定义」，
  与扩展合并后会显示 2 个定义。跳转请用方法上方的 CodeLens。

## 开发

```bash
npm install
npm run build      # typecheck + esbuild
npm test           # 单元测试（纯 node，无 VS Code 依赖）
npm run smoke      # 构建冒烟脚本 out/smoke.mjs
npm run package    # 产出 vsix（自动先 build）
```

冒烟用法：

```bash
node out/smoke.mjs <fenix xml 文件…>
```

设计与实现细节见仓库中的 `DESIGN.md`，版本记录见 `CHANGELOG.md`。

## 图标

使用 fenix 官方凤凰 logo（`docs/assets/images/logo.png`，116×113）放大到 256×256，
原图保留在 `media/fenix-logo-original.png`。

## License

MIT

## 发布

见 `PUBLISH.md`。仓库包含 `.github/workflows/publish.yml`：

- 推送 `v*` tag（`npm version patch && git push --follow-tags`）或手动触发 Actions
- 使用 **Trusted Publishing（GitHub OIDC）** 发布，不存储任何 PAT / 长期密钥
- 要求 `@vscode/vsce` ≥ 4.x（`--oidc`）
