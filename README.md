# Stage1st（S1）Flare 插件

Stage1st 的 Flare Social Plugin API v1 适配器。可游客浏览公开版面，也可登录 S1 访问账号有权限的内容。

- 内置游戏、动漫、归墟、影视和游戏精华时间线。版面目录从 S1 读取，包含站点返回的子版。
- 帖子详情包含楼主正文和后续楼层，支持分页、图片、GIF 和用户资料。
- 添加账号时输入 `stage1st.com`。插件在 Flare 内置浏览器打开 S1 登录页，用会话 Cookie 校验账号。
- S1 的版面权限沿用网站设置。发帖、回帖、通知和站内搜索未接入。

`plugin.fpp` 是本地安装包。支持导入插件包的 Flare 客户端可在插件管理中选择它。开发时也可加载这个目录。

```sh
npm ci
npm run package
```

首次发布时在 GitHub 仓库根目录提交 `manifest.json`、`plugin.js`、`assets/`、`locales/` 和构建源码。版本标签与 manifest 一致。
