
## 逐字打轴数据契约 v1

### 1. 逐字时间数据结构（已存在，复用不新建）
LyricLine.chars: Array<{ c: string, t: number }> | null
  - c: 该字（可含跟随的标点，如 "好，"）
  - t: 该字开始的音频绝对秒数（来自 audio.currentTime）
  - null 表示该行没有逐字时间（普通 LRC / 未打轴）
  - chars 拼起来必须等于 line.text（标点跟随前字，空格不单独成字）

### 2. 逐字打轴状态（新增，与逐行 tapped 完全隔离）
tappingStore.state 新增：
  charMode: false            // 是否处于逐字模式（开关，与逐行 enabled 并列）
  charLineIndex: 0           // 当前正在细化的行下标（指向 tapTarget 数组）
  charCursor: 0              // 当前行内待打轴的字符下标
  charDraft: {}              // { [lineIndex]: Array<{c,t}> } 逐字草稿，与行下标平行
  charUndoStack: []          // 撤销栈，独立于逐行 undoStack

### 3. 状态机（空格键行为）
charMode=false → 走现有逐行 record()，行为一字不变（向后兼容的硬保证）
charMode=true  → charRecord()：
  1. 若当前行无行时间 → 拒绝并提示"请先给该行打行时间"（返回 {blocked:true,reason})
  2. t = audio.currentTime（禁止用按键间隔/墙钟）
  3. 跳过不可打轴字符（纯空格）→ 不记录、不推进
  4. 记录 charDraft[line][charCursor] = { c, t }，标点跟随前字（并入前一个 char.c）
  5. charCursor 前进到下一个可打轴字符
  6. 行内字符打完 → charLineIndex 前进到下一行，charCursor 归零
  7. 越界保护：末行末字再按空格 → 覆盖末字（不得无反应）
  8. 压入 charUndoStack（含 prevCharCursor/prevLineIndex）

### 4. 键盘冲突规避
空格在 charMode 下必须 preventDefault（同现有 onSpace 的既有理由：否则页面滚动）。
优先级：charMode 打轴 > 逐行打轴 > 播放/暂停（沿用现有 onSpace 的四档优先级，把逐字插到最前）

### 5. 持久化格式（localStorage，随歌词一起）
键：lrc-scroller:charTapping:v1
值：{ textHash: string, drafts: { [lineIndex]: Array<{c,t}> }, charLineIndex, charCursor }
  - textHash：歌词全文的指纹。恢复时指纹不符 → 丢弃草稿并提示（需求7"编辑歌词后安全处理"）
  - 逐行草稿仍留 sessionStorage（不改动，避免破坏现有行为）

### 6. 编辑歌词后的字符对应安全处理
重新导入/编辑歌词 → 逐行重新匹配 chars：
  按行文本精确匹配（text 相等）→ 沿用该行 chars
  文本变了 → chars 置 null，并给 warning（不静默错位）
  行数变了 → 多出的草稿丢弃

### 7. 渲染契约（预览 = 导出，硬要求）
进度色设置：settings.color.charProgress（新增，默认 '#4c8dff'）
进度计算：charProgressAt(line, timeSec) → 0..1
  - 时间 <= chars[0].t → 0
  - 时间 >= chars[last].t → 1（用最后一个字的时间，不延伸到行尾）
  - 之间：平滑插值 —— 找到 chars[i].t <= t < chars[i+1].t，
    ratio = (t - chars[i].t) / (chars[i+1].t - chars[i].t)，
    progress = (i + ratio) / chars.length
预览：LyricLine 用 background-clip:text + linear-gradient 实现左→右覆盖
导出：renderFrame 用 ctx.save() + clip 到文字宽度 × progress 的矩形，再用进度色重绘一遍
两侧必须用**同一个** charProgressAt 函数（放在 core/charProgress.js），保证几何一致


## 已定决策记录（2026-10 补充）

### 进度插值模式：默认 smooth，保留 step
用户决定「暂时不做整字跳变，但保留制作的余地」。实现方式：

```js
export const CHAR_PROGRESS_MODES = ['smooth', 'step']
export const DEFAULT_CHAR_PROGRESS_MODE = 'smooth'
export function charProgressAt(chars, timeSec, mode = DEFAULT_CHAR_PROGRESS_MODE)
```

- 第三参数可省略 → 既有两参数调用行为完全不变（向后兼容）
- `smooth`：字内线性插值（当前默认）
- `step`：`ratio` 恒为 0，到达字时间点才整字变色
- 两种模式**共用同一个二分结果 lo**，只在 ratio 一项上分叉，
  所以边界（首字前 / 首字 / 末字 / 末字后 / null）不可能产生分歧
- 切换成本：改调用方传参，不重写公式。有 5 条测试盯着两种模式

### 单字行边界
`timeSec <= chars[0].t` 优先于 `>= chars[n-1].t`，单字行在首字时刻取 0。
维持此行为：若改成「一到达就全亮」，多字行在首字时刻也会变成非 0，
破坏「首字没唱完不该亮」的既有直觉。

### applyChars 的 tapTargetKind 闸
只认 `tapTargetKind === 'lines'`。混合文件里 tapTarget 指向无时间的 droppedLines，
按下标写进 lyrics.lines 会拿 A 行的字改 B 行（静默错位）。
