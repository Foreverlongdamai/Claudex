// Claudex 的图标：深色圆角方块里一个白色的、右边开口的圆环。用代码画，不依赖图片文件。
// 纯函数（不依赖 Electron）：托盘、窗口图标和打安装包时生成 .ico 都用它。

/** 画一个 size×size 的图标，返回 RGBA 像素（每像素 4 字节，带抗锯齿） */
export function iconPixels(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.22; // 方块圆角
  const ringR = size * 0.3;
  const ringW = size * 0.1;
  const gap = Math.PI / 4.2; // 开口的半角
  const ss = 4; // 每个像素采样 4×4 次做抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = x + (sx + 0.5) / ss - 0.5;
          const fy = y + (sy + 0.5) / ss - 0.5;
          // 圆角方块
          const dx = Math.max(Math.abs(fx - c) - (c - radius), 0);
          const dy = Math.max(Math.abs(fy - c) - (c - radius), 0);
          if (dx * dx + dy * dy > radius * radius) continue;
          bg++;
          // 圆环（右边开口）
          const d = Math.hypot(fx - c, fy - c);
          const ang = Math.abs(Math.atan2(fy - c, fx - c));
          if (Math.abs(d - ringR) <= ringW / 2 && ang > gap) fg++;
        }
      }
      const n = ss * ss;
      const a = bg / n;
      const f = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      // 背景 #262626，圆环白色
      px[i] = Math.round(38 + (255 - 38) * f);
      px[i + 1] = Math.round(38 + (255 - 38) * f);
      px[i + 2] = Math.round(38 + (255 - 38) * f);
      px[i + 3] = Math.round(255 * a);
    }
  }
  return px;
}

/** RGBA → Electron nativeImage.createFromBitmap 要的 BGRA */
export function toBgra(rgba: Uint8Array): Buffer {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2];
    out[i + 1] = rgba[i + 1];
    out[i + 2] = rgba[i];
    out[i + 3] = rgba[i + 3];
  }
  return out;
}
