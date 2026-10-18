"use client";

import { useState } from "react";

/**
 * 会长头像（对齐酒馆：一个角色一张图）。
 * 有图 → 圆形裁切显示；无图或加载失败 → 回落名字首字。
 * 尺寸 / 边框等样式由 className 决定（沿用各处的圆形章样式）。
 */
export default function Avatar({
  src,
  name,
  className,
}: {
  src?: string | null;
  name: string;
  className?: string;
}) {
  // 记住「加载失败的那个 src」而不是一个布尔：换了新头像（src 变化）时能重新尝试
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src && failedSrc !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={`${className ?? ""} object-cover`}
        onError={() => setFailedSrc(src)}
      />
    );
  }
  return <span className={className}>{name.slice(0, 1)}</span>;
}
