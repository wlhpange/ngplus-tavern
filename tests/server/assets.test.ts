import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { saveAsset, saveScene, sceneFilename, listSceneFiles, invalidateSceneFiles } from "../../src/server/assets";

let tmp: string;
let previousDbPath: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngplus-assets-"));
  previousDbPath = process.env.DATABASE_PATH;
  // dataDir() = dirname(DATABASE_PATH)，测试资产写进临时目录
  process.env.DATABASE_PATH = path.join(tmp, "test.db");
});

afterAll(() => {
  if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDbPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 60, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe("资产压缩（sharp）", () => {
  it("头像压到 512 长边并转 WebP", async () => {
    const file = await saveAsset("avatar", await png(1600, 1200), "avatar.png", "image/png");
    expect(file.endsWith(".webp")).toBe(true);
    const meta = await sharp(path.join(tmp, "avatars", file)).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(512);
  });

  it("配图压到 1280 长边，sceneFilename 能找到 .webp", async () => {
    const buf = await png(2000, 1000);
    const file = await saveScene("msg-1", buf);
    expect(file).toBe("msg-1.webp");
    expect(sceneFilename("msg-1")).toBe("msg-1.webp");
    expect(listSceneFiles(Date.now() + 10_000).get("msg-1")).toBe("msg-1.webp");
    invalidateSceneFiles();
  });
});
