# 发布到 VS Code Marketplace

> 不需要 Azure DevOps PAT。使用 **Trusted Publishing（GitHub OIDC）**，仓库里不保存任何长期密钥。
> 也可以手动上传 vsix 快速上线。

---

## 一、创建 Publisher

1. 打开 <https://marketplace.visualstudio.com/manage>，用 Microsoft 账号登录
2. 左侧 **Create publisher**
   - **ID**：`dodo`（必须与 `package.json` 的 `publisher` 一致，创建后不可修改）
   - **Name**：显示名称
3. 创建完成

> `package.json` 里已配置：`publisher` = `dodo`。

---

## 二、Trusted Publishing 配置（一次性）

### 2.1 在 Marketplace 创建信任策略

1. 进入 <https://marketplace.visualstudio.com/manage> → `dodo` publisher
2. 点 **Trusted Publishing** → 展开 **Create**，填写：

   | 字段 | 值 |
   |---|---|
   | Policy name | `Release workflow` |
   | Repository owner | `dorea` |
   | Repository | `fenix-helper` |
   | Workflow | `publish.yml` |
   | Environment | 留空（workflow 未使用 GitHub environment） |

3. 点 **Create**

> 五个字段必须与仓库实际信息**完全一致**，否则 OIDC token 交换会失败。
> 私有仓库需在创建策略后 **48 小时内**成功执行一次 workflow，策略才会被永久激活。

### 2.2 仓库已包含的 workflow

`.github/workflows/publish.yml`：

- 触发：推送 `v*` tag，或 Actions 页面手动触发
- 权限：`contents: read` + `id-token: write`（OIDC 必需）
- 步骤：`npm ci` → `npm run build`（含类型检查）→ `npm test` → `vsce publish --oidc`

### 2.3 发布新版本

```bash
# 1) 升版本号并打 tag
npm version patch -m "chore: release %s"    # 0.5.1 → 0.5.2

# 2) 推送 tag，触发 Actions
git push --follow-tags
```

执行结果在 GitHub 仓库 **Actions** 页查看。

> `--skip-duplicate`：版本号已存在时静默跳过，可安全重跑。
> 若信任策略还没配好，先别推 tag（推分支不会触发）。

---

## 三、手动上传（备选，无需任何配置）

```bash
npm run build
npm run package        # 生成 fenix-helper-<版本>.vsix
```

1. 进入 <https://marketplace.visualstudio.com/manage> 的 `dodo` publisher
2. **New extension** → **Visual Studio Code**
3. 拖入 `.vsix`
4. 等待处理（通常几分钟）

扩展地址：`https://marketplace.visualstudio.com/items?itemName=dodo.fenix-helper`

---

## 四、推代码到 GitHub

先在 GitHub 建一个空仓库（**不要**勾 README / .gitignore / LICENSE），然后：

```bash
git remote add origin https://github.com/dorea/fenix-helper.git
git push -u origin main
```

> 若 `package.json` 里没有 `repository`，README 中的相对链接在 Marketplace 上会失效；
> 需要时可补上 `repository.url`，或保持 README 只用行内代码而非相对链接。

---

## 五、常见报错

| 报错 | 原因 / 解决 |
|---|---|
| `ERROR Missing publisher name` | `package.json` 的 `publisher` 未填 |
| `ERROR This extension already exists` | 版本号必须大于线上版本，或用 `--skip-duplicate` |
| `ERROR Extension entrypoint(s) missing` | 没先 `npm run build`，`out/extension.js` 不存在 |
| `Allow missing a repository URL` 报错 | 打包脚本已带 `--allow-missing-repository` |
| OIDC token exchange 失败 | 信任策略的 owner / repo / workflow 与实际不符 |
| `--oidc` 未知参数 | vsce 版本过低，需 `@vscode/vsce` ≥ 4.x |
| 发布成功但搜不到 | 索引延迟（分钟级）；直接用扩展 URL 验证 |

---

## 六、本地打包检查

```bash
npm run build
npm test
npx vsce ls            # 查看将打包进 vsix 的文件清单
npm run package
```

应只包含：`readme.md`、`changelog.md`、`package.json`、`out/extension.js`、
`snippets/fenix.json`、`syntaxes/*.tmLanguage.json`、`media/*.png`。
`src/`、`test/`、`.github/`、`PUBLISH.md`、`DESIGN.md`、`*.map` 不进包（见 `.vscodeignore`）。
