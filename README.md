# Spotify · MyGo Music 插件

在 [MyGo Music](https://github.com/egoist/mygo-music) 中浏览 Spotify 曲库和你的资料库，并通过 Spotify Connect 播放。需要 MyGo Music 0.1.22 及以上和 **Spotify Premium**。

<table>
  <tr>
    <td colspan="2"><img src="screenshots/home.png" alt="首页：最近播放和你的热门歌曲"></td>
  </tr>
  <tr>
    <td colspan="2" align="center">首页</td>
  </tr>
  <tr>
    <td width="50%"><img src="screenshots/play.png" alt="正在播放：同步歌词"></td>
    <td width="50%"><img src="screenshots/setting.png" alt="插件设置：Client ID 和 Soloist API Key"></td>
  </tr>
  <tr>
    <td align="center">正在播放与同步歌词</td>
    <td align="center">插件设置</td>
  </tr>
</table>

## 功能介绍和限制

**功能**

- 搜索歌曲、专辑、艺人、歌单和播客。
- 首页：最近播放、热门歌曲、热门艺人和你的歌单。
- 资料库：已点赞的歌曲、收藏的专辑、订阅的播客、全部歌单（分你创建的和收藏的）、关注的歌手；可以点赞、收藏、关注和订阅。
- 歌单：查看、新建、改名、删除，添加、移出歌曲和调整顺序。别人的歌单也能列出歌曲并播放，Spotify 官方歌单和「每周新发现」同样适用，第一次打开时浏览器会多要一次授权。
- 播放：在打开的 Spotify 应用或 [Spotify Soloist](#spotify-soloist) 上播放，可在 MyGo Music 里暂停、拖动、调音量和切换设备。
- 同步歌词：来自 [LRCLIB](https://lrclib.net) 和网易云音乐，外语歌有中文翻译时一并显示。

**限制**

大多来自 Spotify 对第三方应用的规定：

- 别人的歌单和歌手页的热门歌曲要再授权一次 Spotify。跳过授权时，别人的歌单只有封面、名称和曲目数，歌曲要在 Spotify 应用里播放；歌手页改为列出搜索到的该艺人的歌。
- 这两项用的是 Spotify 客户端自己的私有接口（spclient），Spotify 官方文档里没有，公开可查的参考实现是 [librespot](https://github.com/librespot-org/librespot)。Spotify 更新后，插件要跟着更新才能继续用；不授权不影响其他功能。
- 没有推荐、电台和评论。
- 搜索每页最多 10 条。
- 单个歌单最多显示 1000 首。
- 歌词来自第三方，冷门歌曲可能没有，偶尔会匹配到其他版本。

## 必要的准备

Spotify 要求每位使用者用自己的开发者应用，只需配置一次：

1. 打开 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)，用 Premium 账号登录，点 **Create app**。
2. **Redirect URIs** 填 `http://127.0.0.1:43821/callback`（必须是 `127.0.0.1`，不能写 `localhost`），API 勾选 **Web API**，保存。
3. 在应用的 **User Management** 中加入要登录的 Spotify 账号邮箱（最多 5 个账号）。
4. 复制应用的 **Client ID**。

然后安装插件：

1. MyGo Music → 设置 → 插件 → `+` → 从 GitHub 安装，填入 `starriv/mygo-music-spotify`。
2. 在插件设置中粘贴 Client ID。
3. 在来源选择器中选 **Spotify**，点 **登录**，在浏览器中授权。
4. 可选：在插件设置里填 **榜单国家**，两位国家代码（`JP`、`US`、`HK` 这样的）。歌手页显示这个国家的热门歌曲；不填则显示你账号所在地区的。

这时已经可以浏览和搜索。要播放，需要一台打开的 Spotify 应用（电脑、手机或音箱都行），或者按下一节设置 Soloist。

## Spotify Soloist

**为什么需要它**：Spotify 不向第三方应用提供音频，MyGo Music 只能遥控一台已登录的 Spotify 设备来播放。没有 Soloist 时，每次播放前都要先打开一个 Spotify 应用。

**它是什么**：[Spotify Soloist](https://developer.spotify.com/documentation/soloist) 是 Spotify 官方的无界面播放器。插件在后台运行它，它在你的设备列表里显示为「MyGo Music on Mac」，直接在这台电脑上出声。这样不打开 Spotify 应用也能播放。支持 Apple 芯片的 Mac（macOS 13 及以上）、x86_64 Windows，以及 x86_64 或 arm64 的 Linux（需要 PipeWire 或 PulseAudio）。

**设置**（一次即可）：

1. 按 [Soloist 入门指南](https://developer.spotify.com/documentation/soloist/tutorials/getting-started) 用 Premium 账号生成 API Key，填到插件设置的 **Soloist API Key**。
2. 在插件设置中允许 Spotify 插件运行程序。插件要用它从 Spotify 下载 Soloist（约 11 MB）并启动。Spotify 不允许转发 Soloist，所以插件不附带它。
3. 保存 Key 后，在同一网络下打开手机或电脑上的 Spotify 应用，点「连接到设备」，选择「MyGo Music on Mac」（Windows 上是「MyGo Music on Windows」）完成配对。

之后 Soloist 会自动登录，只在需要时启动，随 MyGo Music 关闭。构建 90 天过期时插件会自动换新；安装包会留在插件数据目录里，插件更新后直接用它重新装好，不需要重新下载。播放器的设备菜单可以随时切换到其他 Spotify 设备，插件会记住你的选择。

**遇到问题时**：

- 提示 Soloist 还在上一个 MyGo Music 会话中运行：先在活动监视器（Mac）或任务管理器（Windows）中退出旧的 MyGo Music 和 Soloist，再播放。
- 下载或解压失败：检查网络或代理后重试。插件不会留下下载到一半的文件，稍后再点播放即可。
- 更新插件前先暂停播放：Windows 上正在运行的 Soloist 可能让插件更新暂时失败，先退出内置播放器（或退出 MyGo Music）再更新。
- 想让另一个 Spotify 账号使用内置播放器：退出登录会清除 Soloist 的配对，重新登录后再配对一次。

注意：API Key 会出现在 Soloist 的启动参数中，这台电脑上以你的身份运行的其他程序能看到它。

---

[AGPL-3.0-only](LICENSE)。Spotify 及其内容归 Spotify AB 所有，本项目不是 Spotify 或 MyGo Music 的官方发布。
