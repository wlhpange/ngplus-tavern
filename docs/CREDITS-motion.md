# 动效素材署名

## Lottie

`assets/lottie/sparkle-loop.json` 与 `assets/lottie/sparkle-burst.json` 是本项目手写的
Lottie 文件（形状 / 关键帧直接生成，配色取自主题 `C.gold`），不来自第三方图库，
随项目一同发布，无额外署名要求。

修改时注意：每个动画段的 keyframe 都要带 `s` / `e` / `i` / `o`，最后一段只留 `t` / `s`；
缺了 `e` 或把标量写成数组会让 lottie 解析成功但画面全空（已踩过）。

## Skia

`src/components/DustField.tsx` 是代码绘制的尘埃层（`@shopify/react-native-skia`），
没有外部素材。
