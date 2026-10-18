"use client";

import { useState } from "react";

/**
 * 图片预览 / 放大：点击图片在「适应屏幕」与「原始尺寸（可滚动）」之间切换；
 * 点图片外空白或右上角 × 关闭。移动端也可直接用系统双指缩放。
 */
export default function ImageLightbox({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(false);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="查看大图"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-2"
    >
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/30 bg-black/50 text-lg text-white"
      >
        ×
      </button>
      <div
        className={`h-full w-full ${
          zoom ? "overflow-auto" : "flex items-center justify-center"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          onClick={(e) => {
            e.stopPropagation();
            setZoom((z) => !z);
          }}
          className={
            zoom
              ? "mx-auto max-w-none cursor-zoom-out"
              : "max-h-full max-w-full cursor-zoom-in object-contain"
          }
        />
      </div>
      <p className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-fs-micro text-white/70">
        {zoom ? "点击图片还原 · 点空白关闭" : "点击图片放大 · 点空白关闭"}
      </p>
    </div>
  );
}
