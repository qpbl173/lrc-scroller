# LRC 歌词滚动字幕

一个**双击打开就能用**的本地网页应用：导入音频 + LRC 歌词 → 自动滚动、高亮当前行 → 深度调样式 → 全屏展示 / 导出视频。

**全程在浏览器里处理，文件不会被上传到任何服务器。**

---

## 功能

- **导入** — 音频（mp3 / wav / m4a / flac / ogg…）与歌词（`.lrc` / `.txt`），支持点选或直接拖到画面中间
- **自动滚动** — 当前行自动居中并放大变色；上下留白、滚动锚点可调
- **歌词虚化** — 以当前行为中心，距离越远越透明（实体区 / 过渡区 / 缓动模式均可调）
- **打轴模式** — 没有时间轴的纯文本歌词，可以边听边按空格补时间
- **深度自定义** — 字体、字号、字重、字间距、行距、当前行放大倍数、颜色、背景、留白、对齐
- **全屏展示** — 隐藏所有界面元素，只留歌词（`F` 键，`Esc` 退出）
- **导出视频** — 480p / 720p / 1080p / 2K / 4K，24 / 30 / 60 帧，普通 MP4 或透明 MOV（均无声）
- **导出 LRC** — 把当前歌词导出成标准 `.lrc` 文件，可重新导入本应用或任何播放器
- **新手教程** — 首次打开自动引导 4 步；之后可随时点顶栏「教程」重看

## 快捷键

| 按键 | 作用 |
|---|---|
| `空格` | 播放 / 暂停（**打轴模式下改为打时间点**） |
| `←` `→` | 快退 / 快进 5 秒（打轴模式下微调刚打完的那行） |
| `↑` `↓` | 音量 |
| `M` | 静音 |
| `F` | 进入 / 退出全屏 |
| `Esc` | 退出全屏 / 关闭教程 |
| `T` | 进入 / 退出打轴模式 |
| `Z` | 打轴模式下撤销上一行 |
| `Ctrl/Cmd + Z` | 撤销「应用到歌词」 |

> 打轴时**空格被用来打点**，所以要暂停请用鼠标点播放条上的暂停键。

## 本地运行

需要 Node.js 18+ 与 pnpm。

```bash
pnpm install
pnpm dev          # 开发服务器 http://127.0.0.1:5173/
```

## 构建

```bash
pnpm build        # → dist/index.html（单文件，双击即可打开）
pnpm build:multi  # → dist-multi/（常规多文件产物，用于静态托管）
```

默认构建成**单文件 HTML**：浏览器对 `<script type="module">` 强制 CORS 校验，
而 `file://` 的 origin 是 `null`，常规产物双击打开会直接白屏。
单文件把 JS/CSS 内联进 HTML，绕开模块加载，才真正做到"双击就能用"。

## 测试

```bash
pnpm test:core    # core 层纯函数单测（零依赖，直接跑 Node）
pnpm test:mov     # MOV 封装、内存上限、取消；装有 FFmpeg 时额外验证真实解码的 RGBA / 帧率 / 时长
```

`src/core/` 被规定为"禁止 import vue 的纯函数层"，
这个脚本就是那条规定的执行者 —— 能在纯 Node 环境跑通，就证明它确实没有浏览器依赖。

`scripts/e2e-*.mjs` 是浏览器端验收脚本，通过 CDP 驱动真实浏览器，
需要一个已启动的 dev server 与一个开好调试端口的 Chromium：

```bash
pnpm dev
# 另开一个窗口，用调试端口启动 Chrome/Edge：
#   chrome.exe --remote-debugging-port=9222 http://127.0.0.1:5173/
node scripts/e2e-stage5-tap.mjs http://127.0.0.1:5173/ 9222
```

## 目录结构

```
src/
├─ core/            纯函数层（禁止 import vue，可 Node 单测）
│  ├─ lrcParser.js     LRC 解析、多标签展开、offset 重算
│  ├─ lrcWriter.js     歌词 → LRC 文本、导出文件名清理
│  ├─ renderFrame.js   单帧渲染：导出与预览共用的排版/动效
│  ├─ fade.js          歌词虚化规则
│  ├─ scroll.js        滚动数学（居中位移、帧率无关平滑）
│  ├─ motion.js        CSS 缓动的逐点求值（导出复刻预览的过渡）
│  ├─ stageGeometry.js 预览舞台几何采集（唯一读 DOM 的一小块）
│  ├─ settings.js      设置默认值 / 校验 / CSS 变量映射
│  ├─ tutorial.js      新手教程步骤与推进
│  ├─ color.js         HEX / RGB / HSL / HSV 与色轮几何
│  ├─ encoding.js      编码探测（GBK 等回退）
│  ├─ clock.js         模拟时钟（无音频时也能滚动）
│  └─ …
├─ composables/     有状态逻辑（useAutoScroll / useTapping / useVideoExport…）
├─ stores/          Pinia：歌词、播放器、设置、打轴、UI
├─ components/      组件
└─ styles/          全局样式与设计变量
```

## 技术栈

Vue 3 · Vite · Pinia · 原生 CSS · JavaScript（无 TypeScript）
普通视频使用 WebCodecs + [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)（H.264，无声）。
透明视频使用 Canvas RGBA PNG 帧 + QuickTime MOV 封装，不需要浏览器支持透明视频编码，也不需要联网下载编码器。

## 透明背景视频

1. 导入音频与 LRC，调整歌词样式。
2. 在设置抽屉的导出面板，将「视频格式」改为「MOV（透明背景，无损）」。
3. 选择分辨率和帧率；建议先试 720p / 30 帧。点击「渲染当前帧」，棋盘格表示透明区域（不会写入视频）。
4. 点击「导出视频」。Chrome / Edge 支持时会先选择保存位置，然后逐帧写入磁盘；其它浏览器会在完成后下载文件。
5. 将 `.mov` 导入支持 QuickTime PNG 的剪辑软件，叠在背景视频上。音频单独对齐。

透明模式忽略舞台背景色，保留文字颜色、描边、缩放、渐隐和半透明边缘。舞台仍显示原背景，导出面板的画布用于检查透明结果。

- PNG/MOV 是无损视频，体积通常大于 H.264 MP4。直接写盘时不累计保存所有帧；内存下载模式限制为 512 MB，超过会停止并提示。
- 取消或写入失败会中止文件流，已存在的目标文件不会被未完成的导出覆盖。新建文件可能留下空文件。
- 网页播放器和部分系统播放器不支持 PNG/MOV；黑底预览也不代表透明通道丢失。请在支持该编码的剪辑软件里检查。
- 如果剪辑软件无法读取 PNG/MOV，可用 FFmpeg 转为带 Alpha 的 ProRes 4444（仍为 MOV）：

  ```bash
  ffmpeg -n -i input.mov -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16 -an output-prores4444.mov
  ```

  Windows 也可运行 `scripts/convert-alpha.ps1 -InputPath "你的透明视频.mov"`。转换需要自行安装 FFmpeg，网页导出本身不需要。

浏览器验收脚本（先运行 `pnpm dev --port 5178`，并安装 Chrome 或 Edge）：

```bash
node scripts/e2e-alpha.mjs http://127.0.0.1:5178/
```

## 已知边界

- **导出是无声视频**，音频请在剪辑软件里对齐。
- **导出不是"渲染加速"**：逐帧渲染，3 分钟的歌词大致要等同样长的时间，且需保持页面在前台。
- **普通 MP4 不含透明通道**：需要真正透明背景时请选择透明 MOV；绿幕 / 黑幕仍可用于 MP4 抠像。
- 打轴需要 `T` 键或播放条按钮；窄屏（≤640px）下播放条会收起该按钮，用 `T` 即可。

## 本文和本项目由AI生成
