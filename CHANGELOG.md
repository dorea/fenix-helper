# Changelog

## 0.5.2

- **支持自定义 fenix XML 目录**：fenix 的 `xml-locations` 可配置任意目录名（此前只识别固定的 `fenix` 目录）。现在自动汇总默认目录、`application*.yml` / `application*.properties` 中的 `fenix.xml-locations`、以及设置项 `fenixHelper.xmlGlobs`，并按文件内容（根节点 `<fenixs`）最终判定，与目录位置无关
- **修复大纲树分组**：自定义目录下的 fenix XML 不再落入「(其他)」，按所在 Maven 模块正确分组；识别不出 Maven 结构时回退到 workspace 文件夹名
- 侧边栏视图标题 `FENIX` → `Fenix`
- 打包清理：排除调试脚本与无关文件

## 0.5.1

- 表格化 SQL 预览：条件勾选、参数值输入、一键复制、内联参数切换

## 0.5.0

- 移除 Java 侧 ctrl+click 定义跳转（与 Red Hat Java 冲突），保留方法上方 CodeLens
- 移除不可点击的 gutter 图标

## 0.4.0

- Java 方法上方 CodeLens：跳转到对应 fenix XML 语句
- 跨包 VO 继承解析、按需查找 Java 文件（不做全量扫描）

## 0.3.0

- MVEL 子集表达式引擎、忠实复刻 fenix v2.7.0 渲染管线的 SQL 渲染器
- webview SQL 预览、增强诊断与 code action、大纲树、SQL 高亮注入语法

## 0.1.0

- 初始版本：XML ↔ Java 双向导航、XSD 标签/属性补全、两级 `#{param.field}` 补全、对齐诊断
