# 字体署名

## 霞鹜文楷 LXGW WenKai

- 用途：界面标题 / 招牌 / 章节名（`Fonts.display`）
- 上游：https://github.com/lxgw/LxgwWenKai
- 版本：v1.530（Regular）
- 授权：SIL Open Font License 1.1，见 `assets/fonts/OFL-LXGWWenKai.txt`

仓库里的 `assets/fonts/LXGWWenKai-Regular.ttf` 是裁剪版：

- 子集：ASCII + GB2312 一二级汉字 + 仓库里出现过的字符，约 6900 字，3.3 MB（上游完整版 25 MB）
- 补字：`✦` `▴` `▾` 三个符号上游缺失（会让标题出现方框），用 fontTools 以几何轮廓补进字体
- 重新生成：用 `pyftsubset` 按字符集裁剪，再用同法补符号；不要直接替换成完整版（APK 会 +22 MB）

正文仍使用系统无衬线字体，等宽数字仍使用系统 monospace，避免小字号下楷体可读性下降。
