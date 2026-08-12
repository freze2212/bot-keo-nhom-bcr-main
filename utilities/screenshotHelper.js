const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

const SCREENSHOT_DIR = path.join(__dirname, "../public/screenshots");
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Ensure screenshot directory exists
 */
function ensureDir() {
  if (!fsSync.existsSync(SCREENSHOT_DIR)) {
    fsSync.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

const MAX_FILES = 30;

/**
 * Clean up screenshots: khi đủ 30 ảnh, làm lệnh xóa sạch TOÀN BỘ ảnh cũ để bắt đầu đợt ảnh mới
 */
async function cleanOldScreenshots(keepFilename = null) {
  try {
    ensureDir();
    const files = await fs.readdir(SCREENSHOT_DIR);
    const pngFiles = files.filter((f) => f.endsWith(".png"));

    if (pngFiles.length >= MAX_FILES) {
      console.log(`[SCREENSHOT CLEANUP] Đã đạt ${pngFiles.length} ảnh (>= ${MAX_FILES}). Đang xoá SẠCH toàn bộ ảnh cũ...`);
      for (const file of pngFiles) {
        if (file === keepFilename) continue;
        const filePath = path.join(SCREENSHOT_DIR, file);
        try {
          await fs.unlink(filePath);
        } catch (e) {}
      }
      console.log(`[SCREENSHOT CLEANUP] Đã xoá sạch ${pngFiles.length} ảnh cũ thành công! Bắt đầu đợt lưu mới.`);
    }
  } catch (err) {
    console.error("[SCREENSHOT CLEANUP ERROR]", err.message);
  }
}

/**
 * Clean up old screenshots specifically for the given table before saving a new one
 */
async function cleanOldScreenshotsForTable(tableName, keepFilename = null) {
  try {
    ensureDir();
    const cleanTable = String(tableName).trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "UNKNOWN";
    const prefix = `sexy_${cleanTable}_`;
    const files = await fs.readdir(SCREENSHOT_DIR);
    for (const file of files) {
      if (
        file !== keepFilename &&
        file.startsWith(prefix) &&
        file.endsWith(".png")
      ) {
        const filePath = path.join(SCREENSHOT_DIR, file);
        try {
          await fs.unlink(filePath);
          console.log(`[SCREENSHOT CLEANUP] Đã xóa tệp ảnh cũ của bàn ${cleanTable}: ${file}`);
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error(`[SCREENSHOT CLEANUP ERROR] Table ${tableName}:`, err.message);
  }
}

/**
 * Cắt viền đen letterbox (căn giữa) — chỉ xử lý file ảnh, không đụng CSS game.
 */
async function trimBlackBorders(filepath, threshold = 28, pad = 2, darkRatio = 0.9) {
  try {
    const sharp = require("sharp");
    const { data, info } = await sharp(filepath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const isDark = (i) =>
      data[i] <= threshold && data[i + 1] <= threshold && data[i + 2] <= threshold;

    const rowDark = (y) => {
      let d = 0;
      let n = 0;
      const step = width > 1200 ? 2 : 1;
      for (let x = 0; x < width; x += step) {
        if (isDark((y * width + x) * channels)) d++;
        n++;
      }
      return d / Math.max(1, n);
    };
    const colDark = (x, y0, y1) => {
      let d = 0;
      let n = 0;
      const step = height > 800 ? 2 : 1;
      for (let y = y0; y <= y1; y += step) {
        if (isDark((y * width + x) * channels)) d++;
        n++;
      }
      return d / Math.max(1, n);
    };

    let top = 0;
    let bottom = height - 1;
    let left = 0;
    let right = width - 1;
    while (top < height - 1 && rowDark(top) >= darkRatio) top++;
    while (bottom > top && rowDark(bottom) >= darkRatio) bottom--;
    while (left < width - 1 && colDark(left, top, bottom) >= darkRatio) left++;
    while (right > left && colDark(right, top, bottom) >= darkRatio) right--;

    top = Math.max(0, top - pad);
    left = Math.max(0, left - pad);
    bottom = Math.min(height - 1, bottom + pad);
    right = Math.min(width - 1, right + pad);

    const cropW = right - left + 1;
    const cropH = bottom - top + 1;
    const trimmed =
      top > 2 || left > 2 || height - 1 - bottom > 2 || width - 1 - right > 2;
    if (!trimmed || cropW < 200 || cropH < 150) return false;

    const ext = path.extname(filepath).toLowerCase();
    const tmpPath = filepath + ".crop.tmp" + (ext || ".png");
    let pipeline = sharp(filepath).extract({
      left,
      top,
      width: cropW,
      height: cropH,
    });
    if (ext === ".jpg" || ext === ".jpeg") {
      pipeline = pipeline.jpeg({
        quality: Math.min(100, Math.max(70, Number(process.env.CAPTURE_JPEG_QUALITY || 95) || 95)),
        mozjpeg: true,
      });
    } else {
      pipeline = pipeline.png();
    }
    await pipeline.toFile(tmpPath);
    await fs.unlink(filepath).catch(() => {});
    await fs.rename(tmpPath, filepath);
    console.log(
      `[SCREENSHOT CROP] center-trim → ${cropW}x${cropH} (was ${width}x${height})`
    );
    return true;
  } catch (e) {
    console.warn(`[SCREENSHOT CROP] skip: ${e.message}`);
    return false;
  }
}

/**
 * Save screenshot from Playwright page or frame
 * @param {object} target - Playwright Page or Frame
 * @param {string} tableName - e.g. "C04"
 * @param {object} options - optional { roundNum, shoeNum, isFullPage }
 */
async function saveScreenshot(target, tableName = "UNKNOWN", options = {}) {
  try {
    ensureDir();

    const cleanTable = String(tableName).trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "UNKNOWN";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const roundStr = options.roundNum ? `_R${options.roundNum}` : "";
    const filename = `sexy_${cleanTable}${roundStr}_${timestamp}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);

    let saved = false;
    if (target && typeof target.screenshot === "function") {
      try {
        await target.screenshot({
          path: filepath,
          fullPage: false,
          timeout: 6000,
        });
        console.log(`[SCREENSHOT SAVED ELEMENT/FRAME] ${filepath}`);
        saved = true;
      } catch (elemErr) {
        console.warn(`[SCREENSHOT WARNING] Chụp element thất bại (${elemErr.message}), cắt trực tiếp vùng iframe game...`);
      }
    }

    if (!saved && options.pageObj && typeof options.pageObj.screenshot === "function") {
      const gameIframe = await options.pageObj.$("iframe#seamless-game").catch(() => null);
      if (gameIframe) {
        const box = await gameIframe.boundingBox().catch(() => null);
        if (box && box.width > 100 && box.height > 100) {
          await options.pageObj.screenshot({
            path: filepath,
            clip: { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height },
            timeout: 6000,
          });
          console.log(`[SCREENSHOT SAVED CLIPPED GAME] ${filepath}`);
          saved = true;
        }
      }

      if (!saved) {
        await options.pageObj.screenshot({
          path: filepath,
          fullPage: false,
          timeout: 6000,
        });
        console.log(`[SCREENSHOT SAVED PAGE FALLBACK] ${filepath}`);
        saved = true;
      }
    }

    if (!saved) throw new Error("Target does not support .screenshot()");

    // Chỉ crop file ảnh (viền đen 4 phía), không sửa CSS game
    if (options.trimBlack !== false) {
      await trimBlackBorders(filepath);
    }

    // Chỉ xóa ảnh cũ sau khi ảnh mới đã ghi xong; luôn giữ file vừa tạo.
    await cleanOldScreenshotsForTable(tableName, filename);
    await cleanOldScreenshots(filename);

    return {
      success: true,
      filename,
      filepath,
      url: `/screenshots/${filename}`,
    };
  } catch (error) {
    console.error(`[SCREENSHOT ERROR] Table ${tableName}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  saveScreenshot,
  cleanOldScreenshots,
  cleanOldScreenshotsForTable,
  trimBlackBorders,
  SCREENSHOT_DIR,
};
